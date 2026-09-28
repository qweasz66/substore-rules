/**
 * 仓库: https://github.com/qweasz66/substore-rules
 * 完美对齐七尺宇/xream 沙盒机制
 */

const FILTER_OUT_PATTERN = /官网|剩余|流量|套餐|免费|订阅|到期时间|直连|GB|Expire|Traffic|重置日|群组|发布页|防失联/i;
const IPV6_PATTERN = /(?:ipv6|\bv6\b|6g|\[v6\])/i;

function isIPv6Server(server) {
  if (!server) return false;
  const cleanServer = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (cleanServer.match(/:/g) || []).length >= 2 || /(?:^|\.)v6[.-]|ipv6[.-]/i.test(cleanServer);
}

function parseOutboundArgs(rawStr) {
  if (!rawStr) return [];
  const rules = [];
  const parts = rawStr.split("🕳").filter(p => p.trim());
  for (const part of parts) {
    if (part.includes("🏷")) {
      const [namePart, tagPart] = part.split("🏷");
      const cleanName = namePart.replace(/^ℹ️/, "").trim();
      const patternStr = tagPart.replace(/^ℹ️/, "").trim();
      try {
        rules.push({ tag: cleanName, pattern: new RegExp(patternStr, "i") });
      } catch (e) {
        rules.push({ tag: cleanName, pattern: null });
      }
    } else {
      const cleanName = part.replace(/^ℹ️/, "").trim();
      rules.push({ tag: cleanName, pattern: null });
    }
  }
  return rules;
}

function cleanNode(node) {
  if (!node) return null;
  const res = { ...node };
  delete res._node;
  delete res.node;
  delete res.subName;
  delete res.collectionName;
  delete res._sub;
  return res;
}

// 主执行器
async function main(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};
  let rawList = [];

  // 1. 获取输入节点
  if (Array.isArray(proxies) && proxies.length > 0) {
    rawList = proxies;
  } else if (proxies && Array.isArray(proxies.proxies) && proxies.proxies.length > 0) {
    rawList = proxies.proxies;
  }

  // 2. 文件管理页上下文补救
  if (rawList.length === 0) {
    const targetName = args.name || "singbox";
    const isSub = (args.type === "单订阅" || args.type === "订阅");
    
    if (typeof getProxies === "function") {
      try {
        rawList = await getProxies({ name: targetName, type: isSub ? "sub" : "collection" });
      } catch (e) {}
    }
    if ((!rawList || rawList.length === 0) && typeof $substore !== "undefined") {
      try {
        if (!isSub && $substore.getCollection) {
          const col = await $substore.getCollection(targetName);
          if (col && Array.isArray(col.proxies)) rawList = col.proxies;
        } else if ($substore.getSub) {
          const sub = await $substore.getSub(targetName);
          if (sub && Array.isArray(sub.proxies)) rawList = sub.proxies;
        }
      } catch (e) {}
    }
  }

  if (!rawList || rawList.length === 0) {
    throw new Error(`[未获取到节点] 请检查参数 #name=${args.name || "singbox"} 是否与组合订阅名称完全吻合！`);
  }

  // 3. 转化为标准 Sing-box 节点
  let singboxNodes = [];
  try {
    if (typeof ProxyUtils !== "undefined" && typeof ProxyUtils.produce === "function") {
      const produced = ProxyUtils.produce(rawList, "Sing-Box");
      singboxNodes = Array.isArray(produced) ? produced : (produced.outbounds || []);
    }
  } catch (e) {}

  if (!singboxNodes || singboxNodes.length === 0) {
    singboxNodes = rawList.map(p => cleanNode(p._node || p.node || p));
  }

  // 4. 读取模板文件
  const TEMPLATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json";
  const resp = await $http.get({
    url: TEMPLATE_URL,
    headers: { "User-Agent": "Sub-Store" }
  });
  const config = JSON.parse(resp.body);

  // 5. 格式化并去重
  const validNodes = [];
  const validTags = [];
  const seen = {};

  for (const item of singboxNodes) {
    if (!item) continue;
    let baseTag = (item.tag || item.name || "Proxy").trim();

    if (FILTER_OUT_PATTERN.test(baseTag)) continue;

    let count = seen[baseTag] || 0;
    seen[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    const node = cleanNode(item);
    node.tag = uniqueTag;

    validNodes.push(node);
    validTags.push(uniqueTag);
  }

  // 6. 分组匹配与 IPv6 提取
  const rules = parseOutboundArgs(args.outbound);
  const matchedGroups = {};
  for (const r of rules) {
    matchedGroups[r.tag] = [];
  }
  const ipv6Tags = [];

  for (const node of validNodes) {
    for (const r of rules) {
      if (r.pattern && r.pattern.test(node.tag)) {
        matchedGroups[r.tag].push(node.tag);
      }
    }
    const srv = node.server || node.host || "";
    if (IPV6_PATTERN.test(node.tag) || isIPv6Server(srv)) {
      ipv6Tags.push(node.tag);
    }
  }

  // 7. 注入到模板策略组中
  const baseOutbounds = [];
  const groupOutbounds = [];

  for (const o of (config.outbounds || [])) {
    if (["direct", "block", "dns"].includes(o.type)) {
      baseOutbounds.push(o);
    } else if (["urltest", "selector"].includes(o.type)) {
      groupOutbounds.push(o);
    }
  }

  for (const g of groupOutbounds) {
    const tagName = g.tag || "";
    if (matchedGroups[tagName] && matchedGroups[tagName].length > 0) {
      g.outbounds = matchedGroups[tagName];
    } else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["DIRECT"];
    } else if (tagName === "♻️ 自动选择" || g.type === "urltest") {
      g.outbounds = validTags.length > 0 ? validTags : ["DIRECT"];
    } else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validTags];
    } else if (!g.outbounds || g.outbounds.length === 0) {
      g.outbounds = ["DIRECT"];
    }
  }

  // 关键：把实体节点直接追加到 outbounds
  config.outbounds = [...baseOutbounds, ...groupOutbounds, ...validNodes];

  return JSON.stringify(config, null, 2);
}

// 兼容 Sub-Store 两种沙盒触发形态
async function produce(proxies) {
  return await main(proxies);
}

if (typeof $arguments !== "undefined" && typeof proxies === "undefined") {
  main().then(res => $done({ content: res })).catch(err =>$done({ error: err.message }));
}

/**
 * Sub-Store 原生绝对兼容产出脚本
 * 仓库: https://github.com/qweasz66/substore-rules
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

async function fetchTemplate() {
  const urls = [
    "https://gh-proxy.com/https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json",
    "https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json"
  ];
  for (const u of urls) {
    try {
      const resp = await $http.get({ url: u, headers: { "User-Agent": "Sub-Store" } });
      if (resp && resp.body) {
        return JSON.parse(resp.body);
      }
    } catch (e) {}
  }
  throw new Error("拉取远程 template-acl.json 失败，请检查网络或模板链接！");
}

async function produce(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};
  let rawList = [];

  // 1. 获取源节点
  if (Array.isArray(proxies) && proxies.length > 0) {
    rawList = proxies;
  } else if (proxies && Array.isArray(proxies.proxies) && proxies.proxies.length > 0) {
    rawList = proxies.proxies;
  }

  // 跨上下文拉取 (Files 页面)
  if (rawList.length === 0) {
    const targetName = args.name || "singbox";
    const isSub = (args.type === "单订阅" || args.type === "订阅");
    const subType = isSub ? "sub" : "collection";

    if (typeof getProxies === "function") {
      try {
        rawList = await getProxies({ name: targetName, type: subType });
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
    throw new Error(`[未获取到节点] Sub-Store 未能拉取到【${args.name || "未指定"}】的节点，请检查组合订阅是否为空！`);
  }

  // 2. 编译为 Sing-box 出站节点
  let singboxNodes = [];
  try {
    if (typeof ProxyUtils !== "undefined" && typeof ProxyUtils.produce === "function") {
      const res = ProxyUtils.produce(rawList, "Sing-Box");
      singboxNodes = Array.isArray(res) ? res : (res.outbounds || []);
    }
  } catch (e) {}

  if (!singboxNodes || singboxNodes.length === 0) {
    singboxNodes = rawList.map(p => cleanNode(p._node || p.node || p));
  }

  // 3. 拉取模板
  const config = await fetchTemplate();

  // 4. 清洗并保证 Tag 唯一
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

  // 5. 分组匹配
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

  // 6. 重组 outbounds
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

  // 节点实体排在最后，策略组排在前面
  config.outbounds = [...baseOutbounds, ...groupOutbounds, ...validNodes];

  // 7. 终极兼容返回：无论 Sub-Store 需要对象还是字符串，一并处理
  return JSON.stringify(config, null, 2);
}

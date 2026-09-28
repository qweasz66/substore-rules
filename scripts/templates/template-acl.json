/**
 * Sub-Store 原生通用 Sing-box 产出脚本 (强制注入版)
 * 仓库: https://github.com/qweasz66/substore-rules
 */

const FILTER_OUT_PATTERN = /官网|剩余|流量|套餐|免费|订阅|到期时间|直连|GB|Expire|Traffic|重置日|群组|发布页|防失联/i;
const IPV6_PATTERN = /(?:ipv6|\bv6\b|6g|\[v6\])/i;

function isIPv6Server(server) {
  if (!server) return false;
  const cleanServer = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (cleanServer.match(/:/g) || []).length >= 2 || /(?:^|\.)v6[.-]|ipv6[.-]/i.test(cleanServer);
}

// 解析七尺宇/xream 的 outbound 参数
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

// 彻底还原与清洗节点
function formatSingboxNode(p) {
  if (!p) return null;
  // Sub-Store 节点可能嵌套在 _node 或 node 中
  let n = p._node ? { ...p._node } : (p.node ? { ...p.node } : { ...p });
  
  // 必须保证 tag
  let tag = (n.tag || n.name || p.name || p.tag || "").trim();
  if (!tag) return null;
  n.tag = tag;

  // 清除 Sub-Store 私有字段
  delete n._node;
  delete n.node;
  delete n.subName;
  delete n.collectionName;
  delete n._sub;
  return n;
}

async function produce(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};
  let rawList = [];

  // 1. 尝试从入参获取
  if (Array.isArray(proxies) && proxies.length > 0) {
    rawList = proxies;
  } else if (proxies && Array.isArray(proxies.proxies) && proxies.proxies.length > 0) {
    rawList = proxies.proxies;
  }

  // 2. 关键修复：如果入参为空，强制通过 Sub-Store API 主动拉取订阅
  if (rawList.length === 0) {
    const subName = args.name || "singbox";
    const isSub = (args.type === "单订阅" || args.type === "订阅");
    
    // 优先调用全局 getProxies
    if (typeof getProxies === "function") {
      try {
        rawList = await getProxies({ name: subName, type: isSub ? "sub" : "collection" });
      } catch (e) {}
    }
    
    // 兜底调用 $substore API
    if ((!rawList || rawList.length === 0) && typeof $substore !== "undefined") {
      try {
        if (isSub && $substore.getSub) {
          const sub = await $substore.getSub(subName);
          rawList = sub ? (sub.proxies || []) : [];
        } else if ($substore.getCollection) {
          const col = await $substore.getCollection(subName);
          rawList = col ? (col.proxies || []) : [];
        }
      } catch (e) {}
    }
  }

  // 如果依然取不到节点，直接在输出里报错，避免只输出空模板
  if (!rawList || rawList.length === 0) {
    throw new Error(`[Sing-Box Produce] 找不到订阅【${args.name || "singbox"}】或该订阅内节点数为 0！请先确认 Sub-Store 后台该订阅有节点。`);
  }

  // 3. 拉取模板
  const TEMPLATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json";
  const resp = await $http.get({ url: TEMPLATE_URL, headers: { "User-Agent": "Sub-Store" } });
  const config = JSON.parse(resp.body);

  // 4. 清洗与去重节点
  const validNodes = [];
  const validTags = [];
  const seen = {};

  for (const item of rawList) {
    const node = formatSingboxNode(item);
    if (!node) continue;

    // 过滤无用节点
    if (FILTER_OUT_PATTERN.test(node.tag)) {
      continue;
    }

    let baseTag = node.tag;
    let count = seen[baseTag] || 0;
    seen[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    node.tag = uniqueTag;
    validNodes.push(node);
    validTags.push(uniqueTag);
  }

  // 如果全部被过滤了，恢复原始节点
  if (validNodes.length === 0) {
    for (const item of rawList) {
      const node = formatSingboxNode(item);
      if (node) {
        validNodes.push(node);
        validTags.push(node.tag);
      }
    }
  }

  // 5. 正则分类与 IPv6
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

  // 6. 重装策略组并追加实体节点
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
      g.outbounds = validTags;
    } else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      g.outbounds = validTags;
    }
  }

  // 核心：把实体节点放在 baseOutbounds 和策略组的后面，合并导出
  config.outbounds = [...baseOutbounds, ...groupOutbounds, ...validNodes];

  return JSON.stringify(config, null, 2);
}

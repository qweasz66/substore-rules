/**
 * Sub-Store 原生标准 Sing-box 产出脚本
 * 仓库: https://github.com/qweasz66/substore-rules
 */

// 垃圾/提示/广告节点过滤正则
const FILTER_OUT_PATTERN = /官网|剩余|流量|套餐|免费|订阅|到期时间|直连|GB|Expire|Traffic|重置日|群组|发布页|防失联/i;

// IPv6 识别逻辑（名称识别 + 底层地址/域名识别）
const IPV6_NAME_REGEX = /(?:ipv6|\bv6\b|6g|\[v6\])/i;

function isIPv6Server(server) {
  if (!server) return false;
  const cleanServer = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  const colonCount = (cleanServer.match(/:/g) || []).length;
  if (colonCount >= 2) return true;
  if (/(?:^|\.)v6[.-]|ipv6[.-]/i.test(cleanServer)) return true;
  return false;
}

function isNodeIPv6(node) {
  if (!node) return false;
  const tag = node.tag || node.name || "";
  const server = node.server || node.host || "";
  return IPV6_NAME_REGEX.test(tag) || isIPv6Server(server);
}

// 解析七尺宇/xream 风格的 outbound 参数
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
  delete res.subName;
  delete res.collectionName;
  return res;
}

async function produce(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};

  // 1. 获取源节点列表（兼容入参与全局 API 拉取）
  let rawList = [];
  if (Array.isArray(proxies) && proxies.length > 0) {
    rawList = proxies;
  } else if (proxies && Array.isArray(proxies.proxies)) {
    rawList = proxies.proxies;
  } else if (args.name && typeof getProxies === "function") {
    const targetType = (args.type === "单订阅" || args.type === "订阅") ? "sub" : "collection";
    try {
      rawList = await getProxies({ name: args.name, type: targetType });
    } catch (e) {}
  }

  if (!rawList || rawList.length === 0) {
    throw new Error(`[Sing-Box Produce] 未获取到有效节点，请确认组合订阅【${args.name || "未指定"}】存在且有节点！`);
  }

  // 2. 调用 Sub-Store 官方引擎将通用代理编译为标准 Sing-box 节点
  let convertedNodes = [];
  try {
    if (typeof ProxyUtils !== "undefined" && typeof ProxyUtils.produce === "function") {
      const res = ProxyUtils.produce(rawList, "Sing-Box");
      convertedNodes = Array.isArray(res) ? res : (res.outbounds || []);
    }
  } catch (e) {}

  if (!convertedNodes || convertedNodes.length === 0) {
    convertedNodes = rawList.map(p => p._node || p.node || p);
  }

  // 3. 拉取远程模板
  const TEMPLATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json";
  let templateText = "";
  try {
    const resp = await $http.get({
      url: TEMPLATE_URL,
      headers: { "User-Agent": "Sub-Store" }
    });
    templateText = resp.body;
  } catch (err) {
    throw new Error(`[Sing-Box Produce] 获取远程模板失败: ${err.message || err}`);
  }

  const config = JSON.parse(templateText);

  // 4. 清洗节点并打上唯一 Tag
  const validNodes = [];
  const validTags = [];
  const seen = {};

  for (const item of convertedNodes) {
    if (!item) continue;
    let baseTag = (item.tag || item.name || "Proxy").trim();

    // 过滤提示/广告节点
    if (FILTER_OUT_PATTERN.test(baseTag)) {
      continue;
    }

    let count = seen[baseTag] || 0;
    seen[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    const node = cleanNode(item);
    node.tag = uniqueTag;

    validNodes.push(node);
    validTags.push(uniqueTag);
  }

  // 兜底防空
  if (validNodes.length === 0 && convertedNodes.length > 0) {
    for (let i = 0; i < convertedNodes.length; i++) {
      const node = cleanNode(convertedNodes[i]);
      node.tag = (node.tag || `Node-${i + 1}`).trim();
      validNodes.push(node);
      validTags.push(node.tag);
    }
  }

  // 5. 正则分类与 IPv6 收集
  const rules = parseOutboundArgs(args.outbound);
  const matchedGroups = {};
  for (const r of rules) {
    matchedGroups[r.tag] = [];
  }
  const ipv6Tags = [];

  for (const node of validNodes) {
    // 匹配 URL 传过来的正则
    for (const r of rules) {
      if (r.pattern && r.pattern.test(node.tag)) {
        matchedGroups[r.tag].push(node.tag);
      }
    }
    // 判定 IPv6 节点
    if (isNodeIPv6(node)) {
      ipv6Tags.push(node.tag);
    }
  }

  // 6. 策略组重装与节点物理追加
  const baseOutbounds = [];
  const groupOutbounds = [];

  for (const o of (config.outbounds || [])) {
    if (["direct", "block", "dns"].includes(o.type)) {
      baseOutbounds.push(o);
    } else if (["urltest", "selector"].includes(o.type)) {
      groupOutbounds.push(o);
    }
  }

  const finalOutbounds = [...baseOutbounds, ...validNodes];

  for (const g of groupOutbounds) {
    const tagName = g.tag || "";

    if (matchedGroups[tagName] && matchedGroups[tagName].length > 0) {
      g.outbounds = matchedGroups[tagName];
    } else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    } else if (tagName === "♻️ 自动选择" || g.type === "urltest") {
      g.outbounds = validTags.length > 0 ? validTags : ["DIRECT"];
    } else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validTags];
    }

    finalOutbounds.push(g);
  }

  config.outbounds = finalOutbounds;
  return JSON.stringify(config, null, 2);
}

/**
 * 适配七尺宇 / xream 传参规范的 Sing-box 产出脚本
 * 仓库: https://github.com/qweasz66/substore-rules
 */

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (clean.match(/:/g) || []).length >= 2;
}

// 解析七尺宇/xream风格的 outbound 参数
function parseOutboundArgs(rawStr) {
  if (!rawStr) return [];
  const rules = [];
  const parts = rawStr.split("🕳").filter(p => p.trim());
  for (const part of parts) {
    if (part.includes("🏷")) {
      const [namePart, tagPart] = part.split("🏷");
      const cleanName = namePart.replace(/^ℹ️/, "").trim();
      const patternStr = tagPart.replace(/^ℹ️/, "").trim();
      rules.push({
        tag: cleanName,
        pattern: new RegExp(patternStr, "i")
      });
    } else {
      const cleanName = part.replace(/^ℹ️/, "").trim();
      rules.push({
        tag: cleanName,
        pattern: null
      });
    }
  }
  return rules;
}

// 深度提取 sing-box 标准节点
function extractNode(item) {
  if (!item) return null;
  let raw = item._node || item.node || item;
  let node = { ...raw };
  node.tag = (node.tag || node.name || item.name || item.tag || "").trim();
  delete node._node;
  delete node.subName;
  delete node.collectionName;
  return node;
}

async function produce(arg1, arg2) {
  // 兼容不同的 proxies 传入方式
  let rawList = [];
  if (Array.isArray(arg1)) rawList = arg1;
  else if (arg1 && Array.isArray(arg1.proxies)) rawList = arg1.proxies;
  else if (Array.isArray(arg2)) rawList = arg2;

  // 1. 获取远程模板
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

  // 2. 解析七尺宇参数
  const args = typeof $arguments !== "undefined" ? $arguments : {};
  let outboundParamRules = [];
  if (args.outbound) {
    outboundParamRules = parseOutboundArgs(args.outbound);
  }

  // 3. 清洗并标准化节点
  const validNodes = [];
  const validNodeTags = [];
  const seenTags = {};

  for (const item of rawList) {
    const node = extractNode(item);
    if (!node || !node.tag) continue;

    let baseTag = node.tag;
    let count = seenTags[baseTag] || 0;
    seenTags[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    node.tag = uniqueTag;
    validNodes.push(node);
    validNodeTags.push(uniqueTag);
  }

  if (validNodes.length === 0) {
    throw new Error("[Sing-Box Produce] Sub-Store 未获取到任何有效节点，请确认上游订阅是否有节点！");
  }

  // 4. 提取 IPv6 节点
  const ipv6Tags = [];
  for (const node of validNodes) {
    if (IPV6_PATTERN.test(node.tag) || isServerIPv6(node.server)) {
      ipv6Tags.push(node.tag);
    }
  }

  // 5. 根据参数映射策略组
  const groupMatchMap = {};
  for (const r of outboundParamRules) {
    groupMatchMap[r.tag] = [];
  }

  for (const node of validNodes) {
    for (const r of outboundParamRules) {
      if (r.pattern && r.pattern.test(node.tag)) {
        groupMatchMap[r.tag].push(node.tag);
      }
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

  const newOutbounds = [...baseOutbounds, ...validNodes];

  for (const g of groupOutbounds) {
    const tagName = g.tag || "";

    // 优先匹配参数里的规则
    if (groupMatchMap[tagName]) {
      const matched = groupMatchMap[tagName];
      g.outbounds = matched.length > 0 ? matched : ["DIRECT"];
    }
    // 自动选择或测速组
    else if (tagName === "♻️ 自动选择" || g.type === "urltest") {
      g.outbounds = validNodeTags;
    }
    // IPv6 组
    else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    }
    // 手动切换 / 全局代理：放入所有节点
    else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validNodeTags];
    }
    // 其余业务组（🎵 TikTok 等）保持模板纯分组
    newOutbounds.push(g);
  }

  config.outbounds = newOutbounds;
  return JSON.stringify(config, null, 2);
}

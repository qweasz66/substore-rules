/**
 * 七尺宇 / Sub-Store 官方体系标准产出脚本
 * 仓库: https://github.com/qweasz66/substore-rules
 */

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (clean.match(/:/g) || []).length >= 2;
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

async function produce(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};

  // 1. 优先拉取节点
  let rawList = [];
  if (Array.isArray(proxies) && proxies.length > 0) {
    rawList = proxies;
  } else if (proxies && Array.isArray(proxies.proxies)) {
    rawList = proxies.proxies;
  } else if (args.name && typeof getProxies === "function") {
    const targetType = (args.type === "单订阅" || args.type === "订阅") ? "sub" : "collection";
    rawList = await getProxies({ name: args.name, type: targetType });
  }

  if (!rawList || rawList.length === 0) {
    throw new Error(`[Sing-Box Produce] 未获取到节点，请检查组合订阅【${args.name || "未指定"}】是否有可用节点！`);
  }

  // 2. 调用 Sub-Store 原生转化
  let nodes = [];
  if (typeof ProxyUtils !== "undefined" && typeof ProxyUtils.produce === "function") {
    const res = ProxyUtils.produce(rawList, "Sing-Box");
    nodes = Array.isArray(res) ? res : (res.outbounds || []);
  } else {
    nodes = rawList.map(p => p._node || p.node || p);
  }

  // 3. 拉取模板（已加上 gh-proxy）
  const TEMPLATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json";
  const resp = await $http.get({ url: TEMPLATE_URL, headers: { "User-Agent": "Sub-Store" } });
  const config = JSON.parse(resp.body);

  // 4. 去重并提取合法 tag
  const validNodes = [];
  const validTags = [];
  const seen = {};

  for (const n of nodes) {
    if (!n) continue;
    let t = (n.tag || n.name || "Proxy").trim();
    seen[t] = (seen[t] || 0) + 1;
    let finalTag = seen[t] === 1 ? t : `${t} (${seen[t] - 1})`;
    
    const clone = { ...n, tag: finalTag };
    delete clone._node;
    delete clone.subName;
    delete clone.collectionName;
    
    validNodes.push(clone);
    validTags.push(finalTag);
  }

  // 5. 正则分类
  const rules = parseOutboundArgs(args.outbound);
  const matchedGroups = {};
  for (const r of rules) {
    matchedGroups[r.tag] = [];
  }
  const ipv6Tags = [];

  for (const n of validNodes) {
    for (const r of rules) {
      if (r.pattern && r.pattern.test(n.tag)) {
        matchedGroups[r.tag].push(n.tag);
      }
    }
    if (IPV6_PATTERN.test(n.tag) || isServerIPv6(n.server)) {
      ipv6Tags.push(n.tag);
    }
  }

  // 6. 重装 outbounds
  // 必须把节点对象放在前面/后面，并确保各 group 的 outbounds 数组被真切替换
  const finalOutbounds = [];

  for (const out of (config.outbounds || [])) {
    const name = out.tag || "";

    if (matchedGroups[name] && matchedGroups[name].length > 0) {
      out.outbounds = matchedGroups[name];
    } else if (name === "🌐 IPv6 节点") {
      out.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    } else if (name === "♻️ 自动选择" || out.type === "urltest") {
      out.outbounds = validTags;
    } else if (name === "🚀 手动切换" || name === "全局代理") {
      out.outbounds = validTags;
    }

    finalOutbounds.push(out);
  }

  // 把所有实体节点拼入 outbounds
  config.outbounds = [...finalOutbounds, ...validNodes];

  return JSON.stringify(config, null, 2);
}

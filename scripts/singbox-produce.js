/**
 * 完全适配七尺宇 / xream 规范的 Sing-box 产出脚本
 * 支持 URL 中的 #type=组合订阅&name=singbox&outbound=... 完整参数
 * 仓库: https://github.com/qweasz66/substore-rules
 */

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (clean.match(/:/g) || []).length >= 2;
}

// 解析 URL 参数中的 outbound（七尺宇/xream 语法）
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
        rules.push({
          tag: cleanName,
          pattern: new RegExp(patternStr, "i")
        });
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

// 统一清洗 node 对象字段
function cleanNodeObj(node) {
  if (!node) return null;
  const res = { ...node };
  delete res._node;
  delete res.subName;
  delete res.collectionName;
  return res;
}

async function produce(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};

  // 1. 获取源节点列表（同七尺宇底层机制：优先从环境或通过 getProxies 拉取）
  let rawList = [];
  if (Array.isArray(proxies) && proxies.length > 0) {
    rawList = proxies;
  } else if (proxies && Array.isArray(proxies.proxies) && proxies.proxies.length > 0) {
    rawList = proxies.proxies;
  }

  // 若入参为空，且携带了 name 与 type 参数，则调用 Sub-Store 内置 API 获取
  if (rawList.length === 0 && args.name && typeof getProxies === "function") {
    try {
      const targetType = (args.type === "单订阅" || args.type === "订阅") ? "sub" : "collection";
      rawList = await getProxies({ name: args.name, type: targetType });
    } catch (e) {
      // 捕获异常
    }
  }

  if (!rawList || rawList.length === 0) {
    throw new Error(`[Sing-Box Produce] 未能获取到订阅【${args.name || "未指定"}】的节点，请检查组合订阅是否正常包含节点！`);
  }

  // 2. 调用 Sub-Store 内置引擎，将通用代理编译为合法的 Sing-box 节点出站结构
  let singboxNodes = [];
  try {
    if (typeof ProxyUtils !== "undefined" && typeof ProxyUtils.produce === "function") {
      const produced = ProxyUtils.produce(rawList, "Sing-Box");
      singboxNodes = Array.isArray(produced) ? produced : (produced.outbounds || []);
    }
  } catch (e) {
    // 引擎未就绪时降级
  }

  if (!singboxNodes || singboxNodes.length === 0) {
    singboxNodes = rawList.map(p => cleanNodeObj(p._node || p.node || p));
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

  // 4. 解析 URL 中的 outbound 正则规则
  const outboundRules = parseOutboundArgs(args.outbound);

  // 5. 格式化并保证节点 Tag 唯一
  const validNodes = [];
  const validNodeTags = [];
  const seenTags = {};

  for (const item of singboxNodes) {
    if (!item) continue;
    let baseTag = (item.tag || item.name || "Proxy").trim();

    let count = seenTags[baseTag] || 0;
    seenTags[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    const node = cleanNodeObj(item);
    node.tag = uniqueTag;

    validNodes.push(node);
    validNodeTags.push(uniqueTag);
  }

  // 6. 根据 URL 规则匹配地区组与识别 IPv6 节点
  const groupMatchMap = {};
  for (const r of outboundRules) {
    groupMatchMap[r.tag] = [];
  }

  const ipv6Tags = [];

  for (const node of validNodes) {
    const tag = node.tag;
    const server = node.server || "";

    // 匹配 URL 传过来的规则
    for (const r of outboundRules) {
      if (r.pattern && r.pattern.test(tag)) {
        groupMatchMap[r.tag].push(tag);
      }
    }

    // 识别 IPv6
    if (IPV6_PATTERN.test(tag) || isServerIPv6(server)) {
      ipv6Tags.push(tag);
    }
  }

  // 7. 组装出站列表与策略组
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

    // 优先采用 URL 参数匹配出的节点列表
    if (groupMatchMap[tagName] && groupMatchMap[tagName].length > 0) {
      g.outbounds = groupMatchMap[tagName];
    }
    // 自动选择组（urltest）
    else if (tagName === "♻️ 自动选择" || g.type === "urltest") {
      g.outbounds = validNodeTags;
    }
    // 🌐 IPv6 策略组
    else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    }
    // 手动切换 / 全局代理
    else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validNodeTags];
    }
    // 未匹配到的空策略组 fallback 到 DIRECT 防止 sing-box 启动报错
    else if (!g.outbounds || g.outbounds.length === 0) {
      g.outbounds = ["DIRECT"];
    }

    newOutbounds.push(g);
  }

  config.outbounds = newOutbounds;
  return JSON.stringify(config, null, 2);
}

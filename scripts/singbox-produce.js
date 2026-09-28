/**
 * Sub-Store 原生直调版 Sing-box 产出脚本
 * 仓库: https://github.com/qweasz66/substore-rules
 */

const FILTER_OUT_PATTERN = /官网|剩余|流量|套餐|到期时间|重置日|群组|发布页|防失联|Expire\s*Date|Traffic|ExpireDate/i;

const REGION_RULES = {
  "🇭🇰 香港节点": /🇭🇰|HK|hk|香港|港|Hong\s*Kong/i,
  "🇯🇵 日本节点": /🇯🇵|JP|jp|日本|日|Japan|Tokyo|Osaka/i,
  "🇸🇬 狮城节点": /新加坡|坡|狮城|SG|Singapore|🇸🇬/i,
  "🇺🇲 美国节点": /^(?!.*(?:AUS|RUS|澳大利亚|俄罗斯)).*(🇺🇸|US|us|美国|美|United\s*States|America)/i,
  "🇨🇳 台湾节点": /台湾|TW|Taiwan|Taipei|🇹🇼/i,
  "🇰🇷 韩国节点": /韩国|KR|Korea|Seoul|🇰🇷/i,
};

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (clean.match(/:/g) || []).length >= 2;
}

// 统一提取转换为合法的 sing-box 节点对象
function toSingboxNode(p) {
  if (!p) return null;
  // 提取原始节点
  let node = p._node || p.node || p;
  let res = { ...node };

  res.tag = (res.tag || res.name || p.name || p.tag || "Proxy").trim();
  
  // 清除内部冗余属性
  delete res._node;
  delete res.subName;
  delete res.collectionName;
  
  return res;
}

async function produce(proxies) {
  const args = typeof $arguments !== "undefined" ? $arguments : {};
  let targetNodes = [];

  // 1. 多途径获取节点列表
  if (Array.isArray(proxies) && proxies.length > 0) {
    targetNodes = proxies;
  } else if (proxies && Array.isArray(proxies.proxies) && proxies.proxies.length > 0) {
    targetNodes = proxies.proxies;
  } else if (typeof getProxies === "function") {
    // 调用 Sub-Store 内置全局方法拉取
    const name = args.name || "singbox";
    const type = (args.type === "单订阅" || args.type === "订阅") ? "sub" : "collection";
    try {
      targetNodes = await getProxies({ name, type });
    } catch (e) {
      // 容错
    }
  }

  // 2. 拉取远程模板
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

  // 3. 清洗节点并确保 Tag 唯一
  const validNodes = [];
  const validNodeTags = [];
  const seenTags = {};

  for (const item of targetNodes) {
    const node = toSingboxNode(item);
    if (!node || !node.tag) continue;

    // 剔除广告/提示节点
    if (FILTER_OUT_PATTERN.test(node.tag)) {
      continue;
    }

    let baseTag = node.tag;
    let count = seenTags[baseTag] || 0;
    seenTags[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    node.tag = uniqueTag;
    validNodes.push(node);
    validNodeTags.push(uniqueTag);
  }

  // 如果依然没有任何节点，抛出明确错误便于定位
  if (validNodes.length === 0) {
    throw new Error(`未读取到有效节点！Sub-Store 传入数量: ${targetNodes.length}。请确认组合订阅【${args.name || "singbox"}】内有可用节点。`);
  }

  // 4. 地区与 IPv6 分流提取
  const regionTags = {};
  for (const reg in REGION_RULES) {
    regionTags[reg] = [];
  }
  const ipv6Tags = [];

  for (const node of validNodes) {
    const tag = node.tag;
    const server = node.server || "";

    for (const reg in REGION_RULES) {
      if (REGION_RULES[reg].test(tag)) {
        regionTags[reg].push(tag);
      }
    }

    if (IPV6_PATTERN.test(tag) || isServerIPv6(server)) {
      ipv6Tags.push(tag);
    }
  }

  // 5. 组合 outbounds 结构
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

    if (g.type === "urltest") {
      g.outbounds = validNodeTags;
    } else if (regionTags[tagName]) {
      const matched = regionTags[tagName];
      g.outbounds = matched.length > 0 ? matched : ["DIRECT"];
    } else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    } else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validNodeTags];
    }
    newOutbounds.push(g);
  }

  config.outbounds = newOutbounds;
  return JSON.stringify(config, null, 2);
}

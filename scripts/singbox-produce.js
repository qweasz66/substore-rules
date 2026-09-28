/**
 * 适配 Sub-Store 官方内核规范的 Sing-box 产出脚本
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

async function produce(proxies) {
  // 1. 获取传入的节点
  const inputList = Array.isArray(proxies) ? proxies : (proxies && proxies.proxies) ? proxies.proxies : [];
  
  if (inputList.length === 0) {
    throw new Error("[Sing-Box Produce] Sub-Store 未获取到任何上游节点，请检查组合订阅是否包含有效节点！");
  }

  // 2. 关键核心：调用 Sub-Store 内置编译引擎，将通用节点编译为合法 sing-box 出站结构
  let singboxNodes = [];
  try {
    if (typeof ProxyUtils !== "undefined" && typeof ProxyUtils.produce === "function") {
      const produced = ProxyUtils.produce(inputList, "Sing-Box");
      singboxNodes = Array.isArray(produced) ? produced : (produced.outbounds || []);
    }
  } catch (e) {
    // 降级处理
  }

  // 降级兼容：如果环境未暴露 ProxyUtils，直接使用节点原数据
  if (!singboxNodes || singboxNodes.length === 0) {
    singboxNodes = inputList.map(p => p._node || p.node || p);
  }

  // 3. 拉取你的远程模板
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
  const validNodeTags = [];
  const seenTags = {};

  for (const node of singboxNodes) {
    if (!node) continue;
    let baseTag = (node.tag || node.name || "Proxy").trim();

    // 过滤广告/提示节点
    if (FILTER_OUT_PATTERN.test(baseTag)) {
      continue;
    }

    let count = seenTags[baseTag] || 0;
    seenTags[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    const cleanNode = { ...node, tag: uniqueTag };
    delete cleanNode._node;
    delete cleanNode.subName;
    delete cleanNode.collectionName;

    validNodes.push(cleanNode);
    validNodeTags.push(uniqueTag);
  }

  // 5. 地区与 IPv6 分类
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

  // 6. 策略组映射
  const baseOutbounds = [];
  const groupOutbounds = [];

  for (const o of (config.outbounds || [])) {
    if (["direct", "block", "dns"].includes(o.type)) {
      baseOutbounds.push(o);
    } else if (["urltest", "selector"].includes(o.type)) {
      groupOutbounds.push(o);
    }
  }

  // 将转换编译完成的节点追加进 outbounds
  const newOutbounds = [...baseOutbounds, ...validNodes];

  for (const g of groupOutbounds) {
    const tagName = g.tag || "";

    if (g.type === "urltest") {
      g.outbounds = validNodeTags.length > 0 ? validNodeTags : ["DIRECT"];
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

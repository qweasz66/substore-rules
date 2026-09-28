/**
 * Sub-Store 产出为 Sing-box 完整配置脚本（纯净内置规则版）
 * 仓库: https://github.com/qweasz66/substore-rules
 */

// 1. 过滤垃圾提示节点（官网/到期时间/流量等）
const FILTER_OUT_PATTERN = /官网|剩余|流量|套餐|免费|订阅|到期时间|直连|GB|Expire\s*Date|Traffic|ExpireDate/i;

// 2. 地区正则映射表（对齐 template-acl.json 的分组名）
const REGION_RULES = {
  "🇭🇰 香港节点": /^(?!.*(?:ZJ|zijian|自建)).*(🇭🇰|HK|hk|香港|港|Hong\s*Kong)/i,
  "🇯🇵 日本节点": /^(?!.*(?:ZJ|zijian|自建)).*(🇯🇵|JP|jp|日本|日|Japan|Tokyo|Osaka)/i,
  "🇸🇬 狮城节点": /^(?!.*(?:ZJ|zijian|自建)).*(新加坡|坡|狮城|SG|Singapore|🇸🇬)/i,
  "🇺🇲 美国节点": /^(?!.*(?:ZJ|zijian|自建|AUS|RUS|澳大利亚|俄罗斯)).*(🇺🇸|US|us|美国|美|United\s*States|America)/i,
  "🇨🇳 台湾节点": /^(?!.*(?:ZJ|zijian|自建)).*(台湾|TW|Taiwan|Taipei|🇹🇼)/i,
  "🇰🇷 韩国节点": /^(?!.*(?:ZJ|zijian|自建)).*(韩国|KR|Korea|Seoul|🇰🇷)/i,
};

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (clean.match(/:/g) || []).length >= 2;
}

async function produce(proxies) {
  // 模板远程链接
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

  // 3. 过滤并给节点去重打 Tag
  const validNodes = [];
  const validNodeTags = [];
  const seenTags = {};

  for (const p of proxies) {
    if (!p) continue;
    let baseTag = (p.tag || "Node").trim();

    // 剔除提示节点
    if (FILTER_OUT_PATTERN.test(baseTag)) {
      continue;
    }

    let count = seenTags[baseTag] || 0;
    seenTags[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    const nodeObj = { ...p, tag: uniqueTag };
    validNodes.push(nodeObj);
    validNodeTags.push(uniqueTag);
  }

  if (validNodes.length === 0) {
    throw new Error("[Sing-Box Produce] 经清洗后无可用有效节点！");
  }

  // 4. 节点分类（地区与 IPv6）
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

  // 5. 组合策略组与出站
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

    // 自动测速组：填入全部有效节点
    if (g.type === "urltest") {
      g.outbounds = validNodeTags;
    }
    // 地区专属组
    else if (regionTags[tagName]) {
      const matched = regionTags[tagName];
      g.outbounds = matched.length > 0 ? matched : ["DIRECT"];
    }
    // 🌐 IPv6 节点：匹配到填入，未匹配到兜底 DIRECT 或自动选择，规避死锁
    else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    }
    // 手动切换 / 全局代理：塞入所有单节点
    else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validNodeTags];
    }
    // 其余业务组（🎵 TikTok、📹 油管视频、💬 Ai平台等）：直接保留模板纯分组结构
    newOutbounds.push(g);
  }

  config.outbounds = newOutbounds;
  return JSON.stringify(config, null, 2);
}

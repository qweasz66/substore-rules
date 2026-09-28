/**
 * Sub-Store 官方规范定制脚本 (xream 规范扩展)
 * 支持参数化 URL、节点正则清洗、地区自动分流、IPv6 智能识别与防死锁
 * 仓库: https://github.com/qweasz66/substore-rules
 */

// 1. 默认参数与过滤规则（若 URL 未传参则使用以下默认规则）
const DEFAULT_FILTER_OUT = /官网|剩余|流量|套餐|免费|订阅|到期时间|直连|GB|Expire\s*Date|Traffic|ExpireDate|Traffic/i;

const DEFAULT_OUTBOUND_RULES = [
  {
    tag: "♻️ 自动选择",
    pattern: /^(?!.*(?:官网|剩余|流量|套餐|免费|订阅|到期时间|直连|GB|Expire|Traffic)).*$/i,
    isFilter: true
  },
  {
    tag: "🇭🇰 香港节点",
    pattern: /^(?!.*(?:ZJ|zijian|自建)).*(🇭🇰|HK|hk|香港|港|Hong\s*Kong)/i,
    isFilter: true
  },
  {
    tag: "🇯🇵 日本节点",
    pattern: /^(?!.*(?:ZJ|zijian|自建)).*(🇯🇵|JP|jp|日本|日|Japan|Tokyo|Osaka)/i,
    isFilter: true
  },
  {
    tag: "🇸🇬 狮城节点",
    pattern: /^(?!.*(?:ZJ|zijian|自建)).*(新加坡|坡|狮城|SG|Singapore|🇸🇬)/i,
    isFilter: true
  },
  {
    tag: "🇺🇲 美国节点",
    pattern: /^(?!.*(?:ZJ|zijian|自建|AUS|RUS|澳大利亚|俄罗斯)).*(🇺🇸|US|us|美国|美|United\s*States|America)/i,
    isFilter: true
  },
  {
    tag: "🇨🇳 台湾节点",
    pattern: /^(?!.*(?:ZJ|zijian|自建)).*(台湾|TW|Taiwan|Taipei|🇹🇼)/i,
    isFilter: true
  },
  {
    tag: "🇰🇷 韩国节点",
    pattern: /^(?!.*(?:ZJ|zijian|自建)).*(韩国|KR|Korea|Seoul|🇰🇷)/i,
    isFilter: true
  }
];

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  return (clean.match(/:/g) || []).length >= 2;
}

// 解析 URL 参数中的 outbound 规则 (类似 xream 格式)
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
        pattern: new RegExp(patternStr, "i"),
        isFilter: true
      });
    } else {
      const cleanName = part.replace(/^ℹ️/, "").trim();
      rules.push({
        tag: cleanName,
        pattern: null,
        isFilter: false
      });
    }
  }
  return rules;
}

async function produce(proxies) {
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

  // 2. 参数解析
  const args = typeof $arguments !== "undefined" ? $arguments : {};
  let outboundRules = DEFAULT_OUTBOUND_RULES;
  if (args.outbound) {
    const parsed = parseOutboundArgs(args.outbound);
    if (parsed.length > 0) outboundRules = parsed;
  }

  // 3. 清洗节点、过滤无用/广告节点并保证 tag 唯一
  const validNodes = [];
  const validNodeTags = [];
  const seenTags = {};

  for (const p of proxies) {
    if (!p) continue;
    let baseTag = (p.tag || "Node").trim();

    // 默认剔除官网、流量等无用提示节点
    if (DEFAULT_FILTER_OUT.test(baseTag)) {
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

  // 4. 节点分类归纳 (地区匹配 + IPv6 识别)
  const groupMatchMap = {};
  const ipv6Tags = [];

  for (const rule of outboundRules) {
    groupMatchMap[rule.tag] = [];
  }

  for (const node of validNodes) {
    const tag = node.tag;
    const server = node.server || "";

    // 匹配地区组
    for (const rule of outboundRules) {
      if (rule.pattern && rule.pattern.test(tag)) {
        groupMatchMap[rule.tag].push(tag);
      }
    }

    // 匹配 IPv6
    if (IPV6_PATTERN.test(tag) || isServerIPv6(server)) {
      ipv6Tags.push(tag);
    }
  }

  // 5. 组装出站列表 (分离 direct/block 等系统出站与策略组)
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

  // 6. 策略组映射
  for (const g of groupOutbounds) {
    const tagName = g.tag || "";

    // 自动选择组：塞入全部有效清洗节点
    if (tagName === "♻️ 自动选择" || g.type === "urltest") {
      g.outbounds = validNodeTags;
    }
    // 地区专属组
    else if (groupMatchMap[tagName]) {
      const matched = groupMatchMap[tagName];
      g.outbounds = matched.length > 0 ? matched : ["DIRECT"];
    }
    // IPv6 策略组：注入识别到的 v6 节点；若无则平滑回退，杜绝循环依赖
    else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    }
    // 手动切换 / 全局代理：塞入所有单节点
    else if (["🚀 手动切换", "全局代理"].includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...validNodeTags];
    }
    // 其余业务组（🎵 TikTok、📹 油管视频、💬 Ai平台等）：直接保留模板中的纯分组选择！
    newOutbounds.push(g);
  }

  config.outbounds = newOutbounds;
  return JSON.stringify(config, null, 2);
}

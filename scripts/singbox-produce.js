/**
 * Sub-Store 产出为 Sing-box 完整配置脚本
 * 仓库: https://github.com/qweasz66/substore-rules
 */

// 1. 地区正则映射表
const REGION_RULES = {
  "🇭🇰 香港节点": /香港|HK|Hong\s*Kong|🇭🇰/i,
  "🇯🇵 日本节点": /日本|JP|Japan|Tokyo|Osaka|🇯🇵/i,
  "🇺🇲 美国节点": /^(?!.*(?:AUS|RUS|澳大利亚|俄罗斯)).*(美国|\bUS\b|United\s*States|America|🇺🇸)/i,
  "🇸🇬 狮城节点": /新加坡|狮城|SG|Singapore|🇸🇬/i,
  "🇨🇳 台湾节点": /台湾|TW|Taiwan|Taipei|🇹🇼/i,
  "🇰🇷 韩国节点": /韩国|KR|Korea|Seoul|🇰🇷/i,
};

const IPV6_PATTERN = /ipv6|\bv6\b/i;

function isServerIPv6(server) {
  if (!server) return false;
  const clean = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  // 两个或以上冒号即为 IPv6 字面量地址
  return (clean.match(/:/g) || []).length >= 2;
}

async function produce(proxies) {
  // 精确指向你的真实模板路径（带镜像加速）
  const TEMPLATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/qweasz66/substore-rules/main/scripts/templates/template-acl.json";

  let templateText = "";
  try {
    const resp = await $http.get({
      url: TEMPLATE_URL,
      headers: { "User-Agent": "Sub-Store" }
    });
    templateText = resp.body;
  } catch (err) {
    throw new Error(`拉取远程模板失败: ${err.message || err}`);
  }

  const config = JSON.parse(templateText);

  // 2. 节点重命名与去重防冲突
  const parsedNodes = [];
  const nodeTags = [];
  const seenTags = {};

  for (const p of proxies) {
    if (!p) continue;
    let baseTag = (p.tag || "Node").trim();
    let count = seenTags[baseTag] || 0;
    seenTags[baseTag] = count + 1;
    let uniqueTag = count === 0 ? baseTag : `${baseTag} (${count})`;

    const nodeObj = { ...p };
    nodeObj.tag = uniqueTag;

    parsedNodes.push(nodeObj);
    nodeTags.push(uniqueTag);
  }

  if (parsedNodes.length === 0) {
    throw new Error("Sub-Store 未提供任何有效节点！");
  }

  // 3. 整理地区与 IPv6 节点
  const regionTags = {};
  for (const reg in REGION_RULES) {
    regionTags[reg] = [];
  }
  const ipv6Tags = [];

  for (const node of parsedNodes) {
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

  // 4. 策略组分离与重组
  const baseOutbounds = [];
  const groupOutbounds = [];

  for (const o of (config.outbounds || [])) {
    if (["direct", "block", "dns"].includes(o.type)) {
      baseOutbounds.push(o);
    } else if (["urltest", "selector"].includes(o.type)) {
      groupOutbounds.push(o);
    }
  }

  const targetSelectorTags = ["🚀 手动切换", "全局代理"];
  const newOutbounds = [...baseOutbounds, ...parsedNodes];

  for (const g of groupOutbounds) {
    const tagName = g.tag || "";

    // 自动测速组：塞入全部节点
    if (g.type === "urltest") {
      g.outbounds = nodeTags;
    }
    // 地区专用组：塞入对应地区节点（无则 DIRECT 兜底）
    else if (regionTags[tagName]) {
      const matched = regionTags[tagName];
      g.outbounds = matched.length > 0 ? matched : ["DIRECT"];
    }
    // 🌐 IPv6 节点策略组：注入识别到的 v6 节点；若无则平滑回退，杜绝循环依赖
    else if (tagName === "🌐 IPv6 节点") {
      g.outbounds = ipv6Tags.length > 0 ? ipv6Tags : ["♻️ 自动选择", "DIRECT"];
    }
    // 手动切换 / 全局代理：塞入所有单节点供手选手切
    else if (targetSelectorTags.includes(tagName)) {
      const staticItems = (g.outbounds || []).filter(t => ["♻️ 自动选择", "DIRECT", "REJECT"].includes(t));
      g.outbounds = [...staticItems, ...nodeTags];
    }
    // 其余业务组（🎵 TikTok、📹 油管视频、💬 Ai平台等）：直接保留模板中的纯分组层级
    newOutbounds.push(g);
  }

  config.outbounds = newOutbounds;
  return JSON.stringify(config, null, 2);
}

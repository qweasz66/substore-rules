/**
 * 自动识别真实 IPv6 节点并在名字后追加 [IPv6] 标签
 * 仓库: https://github.com/qweasz66/substore-rules
 */

function isIPv6Server(server) {
  if (!server) return false;
  const cleanServer = String(server).trim().replace(/^\[\vert{}\]$/g, "");
  // 地址中含有 2 个以上冒号（原生 IPv6 地址）或者域名带有 v6 标识
  return (cleanServer.match(/:/g) || []).length >= 2 || /(?:^|\.)v6[.-]|ipv6[.-]/i.test(cleanServer);
}

function operator(proxies) {
  return proxies.map(p => {
    const node = p._node || p.node || p;
    const srv = node.server || node.host || "";
    const currentTag = node.tag || node.name || p.name || p.tag || "";

    // 如果底层地址是 IPv6，且名字里还没有写 IPv6，自动追加后缀
    if (isIPv6Server(srv) && !/ipv6|\bv6\b/i.test(currentTag)) {
      const newTag = `${currentTag} [IPv6]`;
      if (node.tag) node.tag = newTag;
      if (node.name) node.name = newTag;
      if (p.name) p.name = newTag;
      if (p.tag) p.tag = newTag;
    }
    return p;
  });
}

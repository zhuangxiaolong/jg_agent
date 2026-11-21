const portraits = [
  'mes-wms-engineering', 'project-delivery', 'mes-wms-requirements', 'mes-wms-backend',
  'mes-wms-frontend', 'mes-wms-fullstack', 'mes-wms-quality', 'project-director',
  'project-manager', 'implementation-engineer'
];

export function ExpertAvatar({ id, size = 28 }: { id: string; size?: number }) {
  const builtin = portraits.includes(id);
  // 副本使用稳定的头像与底色组合，改名或删除档案后历史消息仍能还原。
  let hash = 0;
  if (!builtin) for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const portrait = builtin ? id : portraits[hash % portraits.length];
  return <img className="expert-avatar" alt="" width={size} height={size}
    style={!builtin ? { backgroundColor: `hsl(${(hash >>> 8) % 360} 36% 41%)` } : undefined}
    src={'assets/experts/' + portrait + '.png'} />;
}

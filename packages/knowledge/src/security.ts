/** 导入资料和手工记忆不能成为凭据明文存储区；疑似凭据须由用户先移除。 */
export function assertNoPlaintextCredentials(content: string, options: { allowSchemaMetadata?: boolean } = {}): void {
  const marker = /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b/;
  const privateKey = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/;
  const authorization = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i;
  const credentialUrl = /https?:\/\/[^\s/@:]+:[^\s/@]+@/i;
  const assignment = /["']?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|pwd|connectionstring|密码|口令|密钥|令牌)["']?\s*[:：=]\s*(?:["'][^"'\r\n]+["']|[^\s,;}]+)/i;
  const xmlSecret = /<(?:Password|ApiKey|AccessToken|ClientSecret|ConnectionString)\b[^>]*>\s*[^<\s][^<]*<\//i;
  const credentialColumn = /(?:^|[\t,;|])\s*["']?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|pwd|connectionstring)["']?\s*(?=[\t,;|\r\n]|$)/im;
  const jwt = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;
  let unsafeColumn = credentialColumn.test(content);
  if (unsafeColumn && options.allowSchemaMetadata) {
    const fieldName = /^(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|password|pwd|connectionstring)$/i;
    // 字典中的“字段名、SQL/CLR 类型、属性...”属于结构定义；
    // username,password 这种凭据数据表头仍拒绝，真实赋值和密钥标记始终检查。
    unsafeColumn = content.split(/\r?\n/).some(line => {
      const values = line.split(/[\t,;|]/).map(value => value.trim().replace(/^["']|["']$/g, '')).filter(value => !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(value));
      const index = values.findIndex(value => fieldName.test(value));
      if (index < 0 || values.length === 1) return false;
      const typedSchemaRow = values.some(value => /^(?:n?varchar2?|n?char|text|clob|number|decimal|numeric|integer|bigint|smallint|int|boolean|bit|date|datetime|timestamp|raw|blob|string|guid|int16|int32|int64|double|single|datetimeoffset|byte\[\])(?:\s*\([\d\s,]+\))?(?:\s+(?:null|not null))?$/i.test(value));
      return !typedSchemaRow;
    });
  }
  if (marker.test(content) || privateKey.test(content) || authorization.test(content) || credentialUrl.test(content) || assignment.test(content) || xmlSecret.test(content) || unsafeColumn || jwt.test(content)) {
    throw new Error('资料疑似包含明文密码、Token、API Key 或连接凭据，不能导入或保存；请先移除凭据字段和值。');
  }
}

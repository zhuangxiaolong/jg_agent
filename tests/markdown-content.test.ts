import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JiraIssue } from '../packages/domain/src';
import { jiraWikiImageAttachments, JiraInlineImagePreview, MarkdownContent, removeJiraWikiImageAttachment } from '../apps/desktop/src/renderer/MarkdownContent';

test('会话 Markdown 中文链接显示可读标题并解码文件路径', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '[CD-466_采集过站前端对接说明.md](D:/JG_GIT/42-%E5%B8%8C%E5%A1%94/jz.ims/Doc/%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3/CD-466_%E9%87%87%E9%9B%86%E8%BF%87%E7%AB%99%E5%89%8D%E7%AB%AF%E5%AF%B9%E6%8E%A5%E8%AF%B4%E6%98%8E.md)',
  }));

  assert.match(html, />CD-466_采集过站前端对接说明\.md<\/a>/);
  assert.doesNotMatch(html, />[^<]*%E5%/);
  assert.match(html, /file:\/\/\/D:.*CD-466_%E9%87%87%E9%9B%86/);
});

test('Markdown 尖括号链接支持包含空格的 Windows 路径', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '[接口说明](<D:/项目 文件/开发文档/接口说明.md>)',
  }));

  assert.match(html, />接口说明<\/a>/);
  assert.match(html, /file:\/\/\/D:.*%E9%A1%B9%E7%9B%AE%20%E6%96%87%E4%BB%B6/);
});

test('项目内 Markdown 文件链接点击后在项目文件面板打开', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '[物料信息管理零码开发操作手册](docs/物料信息管理零码开发操作手册.md)',
    onFilePath: () => undefined,
  }));

  assert.match(html, /<button[^>]+title="在项目文件中打开，右键可打开所在目录"[^>]*>物料信息管理零码开发操作手册<\/button>/);
  assert.doesNotMatch(html, /href="docs\/物料/);
});

test('Jira wiki 图片语法按附件名显示会话图片预览组件，而不泄漏为原始标记', () => {
  const issue: JiraIssue = {
    id: '123', key: 'YSG-387', summary: '合成 Jira 任务', description: '', status: '进行中', issueType: '任务',
    url: 'https://jira.example.invalid/browse/YSG-387', fetchedAt: '2026-11-20T00:00:00Z',
    attachments: [{ id: '25', name: 'image-2026-09-19-10-17-25-285.png', mimeType: 'image/png', size: 128, url: 'https://jira.example.invalid/secure/attachment/25/image.png', localImage: { sha256: 'a'.repeat(64), mimeType: 'image/png', size: 128 } }]
  };
  const markup = renderToStaticMarkup(createElement(MarkdownContent, { text: '需求图片：!image-2026-09-19-10-17-25-285.png!', jiraIssue: issue, sessionId: 'session-1' }));
  assert.match(markup, /data-jira-attachment-id="25"/);
  assert.doesNotMatch(markup, /!image-2026-09-19-10-17-25-285\.png!/);
  assert.deepEqual(jiraWikiImageAttachments('正文：!image-2026-09-19-10-17-25-285.png!\n重复：!image-2026-09-19-10-17-25-285.png!', issue), issue.attachments);
  assert.equal(removeJiraWikiImageAttachment('保留 !image-2026-09-19-10-17-25-285.png|thumbnail! 与 !other.png!', issue, '25'), '保留  与 !other.png!');
});

test('Jira 图片卡片支持点击放大并在输入区移除', () => {
  const attachment: JiraIssue['attachments'][number] = { id: '25', name: '需求截图.png', mimeType: 'image/png', size: 128, url: 'https://jira.example.invalid/image.png' };
  const markup = renderToStaticMarkup(createElement(JiraInlineImagePreview, { issueKey: 'YSG-387', attachment, sessionId: 'session-1', onRemove: () => undefined }));
  assert.match(markup, /class="conversation-image-card composer-image-card"/);
  assert.match(markup, /aria-label="放大图片 需求截图\.png"/);
  assert.match(markup, /aria-label="移除附件 需求截图\.png"/);
});

test('未关联到 Jira 图片附件的 wiki 标记保持纯文本，不加载任意图片地址', () => {
  const markup = renderToStaticMarkup(createElement(MarkdownContent, { text: '!https://example.invalid/tracker.png!' }));
  assert.match(markup, /!https:\/\/example\.invalid\/tracker\.png!/);
  assert.doesNotMatch(markup, /<img/);
});

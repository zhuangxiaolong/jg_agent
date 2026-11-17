import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from '../apps/desktop/src/renderer/MarkdownContent';

test('会话 Markdown 中文链接显示可读标题并解码文件路径', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '[CD-466_采集过站前端对接说明.md](D:/JG_GIT/42-%E5%B8%8C%E5%A1%94/jz.ims/Doc/%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3/CD-466_%E9%87%87%E9%9B%86%E8%BF%87%E7%AB%99%E5%89%8D%E7%AB%AF%E5%AF%B9%E6%8E%A5%E8%AF%B4%E6%98%8E.md)',
  }));

  assert.match(html, />CD-466_采集过站前端对接说明\.md<\/a>/);
  assert.doesNotMatch(html, />[^<]*%E5%/);
  assert.match(html, /file:\/\/\/D:\/JG_GIT\/42-%E5%B8%8C%E5%A1%94\/jz\.ims\/Doc\/%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3/);
});

test('Markdown 尖括号链接支持包含空格的 Windows 路径', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    text: '[接口说明](<D:/项目 文件/开发文档/接口说明.md>)',
  }));

  assert.match(html, />接口说明<\/a>/);
  assert.match(html, /file:\/\/\/D:\/%E9%A1%B9%E7%9B%AE%20%E6%96%87%E4%BB%B6\/%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3\/%E6%8E%A5%E5%8F%A3%E8%AF%B4%E6%98%8E\.md/);
});

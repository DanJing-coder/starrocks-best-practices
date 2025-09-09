// src/theme/Mermaid/index.tsx
import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';

/**
 * 说明：
 * - 在 SSR 期间不渲染原始 Mermaid 组件，以避免 `useColorMode` 在没有 ColorModeProvider 时被调用。
 * - 在浏览器端才 require() 原始组件并渲染。
 */

export default function MermaidWrapper(props: any) {
  return (
    <BrowserOnly fallback={<div />}>
      {() => {
        // require 在浏览器时才执行，避免服务端执行 hook 导致错误
        // 使用 require 而不是 import，可以保证在 SSR 阶段不触发模块求值
        // @ts-ignore
        const OriginalMermaid = require('@theme-original/Mermaid').default;
        return <OriginalMermaid {...props} />;
      }}
    </BrowserOnly>
  );
}


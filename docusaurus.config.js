// docusaurus.config.js (完整替换你当前文件中的对应部分)
const config = {
  title: 'StarRocks 最佳实践手册',
  url: 'https://danjing-coder.github.io',
  baseUrl: '/',
  organizationName: 'danjing-coder',
  projectName: 'starrocks-best-practices',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,
  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          routeBasePath: '/docs',
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],

  themeConfig: {
    navbar: {
      title: 'StarRocks 文档',
      items: [
        { to: '/docs/intro', label: '文档', position: 'left' },
        { type: 'docSidebar', sidebarId: 'tutorialSidebar', position: 'right' },
      ],
    },
    // 可选：如果你想控制 mermaid 主题（light/dark），放在这里：
    // mermaid: {
    //   theme: { light: 'neutral', dark: 'forest' },
    //   options: { /* mermaid.initialize options */ },
    // },
  },

  onBrokenLinks: 'ignore',

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      { redirects: [{ from: '/', to: '/docs/intro' }] },
    ],
  ],

  // 只写一个主题项来启用 Mermaid
  themes: ['@docusaurus/theme-mermaid'],

  // 允许 Markdown 中的 ```mermaid``` 代码块
  markdown: {
    mermaid: true,
  },
};

module.exports = config;


const config = {
  title: 'StarRocks 最佳实践手册',
  url: 'https://danjing-coder.github.io',
  baseUrl: '/',
  organizationName: 'danjing-coder', // GitHub 用户名
  projectName: 'starrocks-best-practices', // 仓库名
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
          // 如果有 docs 目录，确保路径正确
          routeBasePath: '/docs', // 如果你想让 docs 成为首页
        },
        blog: false, // 如果没有博客，设为 false
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],
  onBrokenLinks: 'ignore',
  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/',          // 访问根路径 /
            to: '/docs/intro',  // 自动跳转到 /docs/intro
          },
        ],
      },
    ],
  ],

};

module.exports = config;
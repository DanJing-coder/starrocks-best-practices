module.exports = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: '最佳实践',
      collapsed: false,
      items: [
        // 规划与部署
        'cluster-planning',
        'configuration',
        // 使用与开发
        'using_starrocks/onboarding',
        'modeling',
        'connector',
        'using_starrocks/usage',
        // 运维与监控
        'monitoring',
        'logs',
        'inspection',
        // 故障处理
        {
          type: 'category',
          label: '故障处理',
          link: {
            type: 'doc',
            id: 'troubleshooting',
          },
          items: [
            'troubleshooting/disk_capacity',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'StarRocks 原理',
      collapsed: true,
      items: [
        'principles/query_processing',
        'principles/data_ingestion',
        'principles/compaction',
      ],
    },
  ],
};

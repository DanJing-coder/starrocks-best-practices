module.exports = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: '最佳实践',
      collapsed: false,
      items: [
        {
          type: 'category',
          label: '规划与部署',
          items: [
            'cluster-planning',
            'deployment/deploy_checklist',
            'deployment/deployment',
            'configuration',
          ],
        },
        {
          type: 'category',
          label: '使用与开发',
          items: [
            'using_starrocks/onboarding',
            'modeling',
            'connector',
            'using_starrocks/usage',
          ],
        },
        {
          type: 'category',
          label: '运维与监控',
          items: [
            'Monitor/monitoring',
            'Monitor/logs',
            'inspection',
          ],
        },
        {
          type: 'category',
          label: '故障处理',
          link: {
            type: 'doc',
            id: 'troubleshooting/troubleshooting',
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

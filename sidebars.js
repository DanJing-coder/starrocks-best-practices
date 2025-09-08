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
            'using_starrocks/cluster-planning',
            {
              type: 'category',
              label: '部署',
              link: {
                type: 'doc',
                id: 'deployment/deployment',
              },
              items: [
                'deployment/deploy_checklist',
                'deployment/shared_data',
                'deployment/shared_nothing',
              ]
            },
            'using_starrocks/configuration',
          ],
        },
        {
          type: 'category',
          label: '使用与开发',
          items: [
            'using_starrocks/onboarding',
            'using_starrocks/modeling',
            'using_starrocks/connector',
            'using_starrocks/usage',
            'using_starrocks/materialized_view'
          ],
        },
        {
          type: 'category',
          label: '运维与监控',
          items: [
            'Monitor/monitoring',
            'Monitor/logs',
            'Monitor/inspection',
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
            'troubleshooting/load_reached_timeout',
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
        'principles/optimizer',
        'principles/hash_join',
        'principles/join_reorder',
        'principles/runtime_filter',
        'principles/aggregate_operator'
      ],
    },
  ],
};

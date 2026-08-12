/**
 * NFS/DLNA 连接配置页面
 */
import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Switch, Button, message, Typography, Divider, Alert } from 'antd'
import { ApiOutlined, SaveOutlined } from '@ant-design/icons';
import { apiService } from '../../posts/api';

const { Title } = Typography;

const NfsConfig: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const fetchConfig = async () => {
    try {
      const list: any = await apiService.get('/api/admin/setting/list');
      const setting = (Array.isArray(list) ? list : []).find((s: any) => s.key === 'nfs');
      if (setting && setting.value) {
        form.setFieldsValue(JSON.parse(setting.value));
      }
    } catch (error) {
      console.error('获取NFS配置失败:', error);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

  const handleSave = async (values: any) => {
    setLoading(true);
    try {
      await apiService.post('/api/admin/setting/save', {
        admin_keys: 'nfs',
        admin_data: JSON.stringify(values),
      });
      message.success('NFS/DLNA配置保存成功');
    } catch (error: any) {
      message.error(error.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <Title level={3} style={{ marginBottom: 24 }}>
        <ApiOutlined style={{ marginRight: 12 }} />
        NFS / DLNA 连接配置
      </Title>

      <Alert
        message="NFS/DLNA 服务"
        description="启用NFS共享或DLNA媒体服务，允许局域网设备访问文件。"
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
      />

      <Card>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Divider titlePlacement="left">NFS 设置</Divider>

          <Form.Item label="启用NFS" name="nfs_enabled" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>

          <Form.Item label="导出路径" name="export_path" initialValue="/">
            <Input placeholder="NFS导出路径" />
          </Form.Item>

          <Form.Item label="允许的客户端" name="allowed_clients" initialValue="*">
            <Input placeholder="* 表示允许所有，或指定IP/网段" />
          </Form.Item>

          <Divider titlePlacement="left">DLNA 设置</Divider>

          <Form.Item label="启用DLNA" name="dlna_enabled" valuePropName="checked" initialValue={false}>
            <Switch />
          </Form.Item>

          <Form.Item label="DLNA服务名称" name="dlna_name" initialValue="OpenList DLNA">
            <Input placeholder="DLNA服务名称" />
          </Form.Item>

          <Form.Item label="媒体扫描路径" name="media_path" initialValue="/">
            <Input placeholder="DLNA媒体扫描路径" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} icon={<SaveOutlined />}>
              保存配置
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default NfsConfig;

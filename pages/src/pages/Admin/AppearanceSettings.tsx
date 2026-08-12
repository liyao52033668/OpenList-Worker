/**
 * 外观设置页面
 * 管理站点外观、主题、Logo等
 */
import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Select, Button, message, Typography, Divider } from 'antd'
import { BgColorsOutlined, SaveOutlined } from '@ant-design/icons'
import { apiService } from '../../posts/api';

const { Title, Text } = Typography;
const { TextArea } = Input;

const AppearanceSettings: React.FC = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const fetchSettings = async () => {
    try {
      const list: any = await apiService.get('/api/admin/setting/list');
      const setting = (Array.isArray(list) ? list : []).find((s: any) => s.key === 'appearance');
      if (setting && setting.value) {
        form.setFieldsValue(JSON.parse(setting.value));
      }
    } catch (error) {
      console.error('获取外观设置失败:', error);
    }
  };

  useEffect(() => { fetchSettings(); }, []);

  const handleSave = async (values: any) => {
    setLoading(true);
    try {
      await apiService.post('/api/admin/setting/save', {
        admin_keys: 'appearance',
        admin_data: JSON.stringify(values),
      });
      message.success('外观设置保存成功');
    } catch (error: any) {
      message.error(error.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="animate-fade-in-up" style={{ padding: 24, maxWidth: 800 }}>
      <Title level={3} style={{ marginBottom: 24 }}>
        <BgColorsOutlined style={{ marginRight: 12 }} />
        外观设置
      </Title>

      <Card>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Divider titlePlacement="left">基本设置</Divider>

          <Form.Item label="站点标题" name="site_title" initialValue="OpenList">
            <Input placeholder="站点标题" />
          </Form.Item>

          <Form.Item label="站点副标题" name="site_subtitle">
            <Input placeholder="站点副标题" />
          </Form.Item>

          <Form.Item label="站点Logo URL" name="logo_url">
            <Input placeholder="Logo图片URL" />
          </Form.Item>

          <Form.Item label="Favicon URL" name="favicon_url">
            <Input placeholder="Favicon图片URL" />
          </Form.Item>

          <Divider titlePlacement="left">主题设置</Divider>

          <Form.Item label="默认主题" name="default_theme" initialValue="system">
            <Select options={[
              { label: '跟随系统', value: 'system' },
              { label: '亮色模式', value: 'light' },
              { label: '暗色模式', value: 'dark' },
            ]} />
          </Form.Item>

          <Form.Item label="主题色" name="primary_color" initialValue="#3B82F6">
            <Input placeholder="#3B82F6" />
          </Form.Item>

          <Divider titlePlacement="left">自定义代码</Divider>

          <Form.Item label="自定义CSS" name="custom_css">
            <TextArea rows={4} placeholder="自定义CSS样式" />
          </Form.Item>

          <Form.Item label="自定义JavaScript" name="custom_js">
            <TextArea rows={4} placeholder="自定义JavaScript代码" />
          </Form.Item>

          <Form.Item label="页脚HTML" name="footer_html">
            <TextArea rows={3} placeholder="自定义页脚内容" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} icon={<SaveOutlined />}>
              保存设置
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default AppearanceSettings;

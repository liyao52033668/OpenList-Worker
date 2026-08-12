import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Result, Button, Spin, Typography } from 'antd';

const { Text } = Typography;

/**
 * 百度网盘 OAuth 授权回调页
 *
 * 授权完成后百度重定向到本页（URL 带 code），页面把 code 通过 postMessage 回传给
 * 打开授权窗口的挂载点表单页，由表单页携带 client_id/client_secret 兑换 refresh_token 并自动回填。
 * 若未检测到 opener（用户直接访问本页），则展示授权码供手动复制。
 */
const BaiduOAuthCallback: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');
  const [code, setCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const codeValue = searchParams.get('code') || '';
    const errorValue = searchParams.get('error') || '';

    if (errorValue) {
      setState('error');
      setErrorMsg(decodeURIComponent(errorValue));
      window.opener?.postMessage(
        { source: 'openlist-baidu-oauth', error: decodeURIComponent(errorValue) },
        window.location.origin
      );
      return;
    }
    if (!codeValue) {
      setState('error');
      setErrorMsg('授权回调缺少授权码 code');
      window.opener?.postMessage(
        { source: 'openlist-baidu-oauth', error: '授权回调缺少授权码 code' },
        window.location.origin
      );
      return;
    }

    setCode(codeValue);
    setState('success');
    // 把授权码回传给挂载点表单页，由其兑换 refresh_token 并自动回填
    window.opener?.postMessage(
      { source: 'openlist-baidu-oauth', code: codeValue },
      window.location.origin
    );
  }, [searchParams]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      {state === 'loading' && <Spin size="large" />}
      {state === 'success' && (
        <Result
          status="success"
          title="百度授权成功"
          subTitle={
            window.opener
              ? '刷新令牌已回填到挂载点表单，请关闭本窗口返回表单页保存。'
              : '未检测到来源窗口，请复制下方授权码返回表单页手动填写。'
          }
          extra={[
            !window.opener && (
              <Button
                key="copy"
                type="primary"
                onClick={() => { navigator.clipboard?.writeText(code); }}
              >
                复制授权码
              </Button>
            ),
            <Button key="close" onClick={() => window.close()}>关闭窗口</Button>,
          ]}
        >
          {!window.opener && <Text copyable style={{ wordBreak: 'break-all' }}>{code}</Text>}
        </Result>
      )}
      {state === 'error' && (
        <Result
          status="error"
          title="百度授权失败"
          subTitle={errorMsg}
          extra={<Button type="primary" onClick={() => window.close()}>关闭窗口</Button>}
        />
      )}
    </div>
  );
};

export default BaiduOAuthCallback;

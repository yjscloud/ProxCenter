/* ==========================================================================
   ProxCenter — NotFound 404
   ========================================================================== */

import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';

export function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="notfound">
      <div className="notfound-code">404</div>
      <h1 className="notfound-title">页面不存在</h1>
      <p className="notfound-text">
        你访问的地址没有对应的页面，可能是链接已失效或路径输入有误。
      </p>
      <div className="flex gap-12 mt-8">
        <Button variant="primary" onClick={() => navigate('/')}>
          返回仪表盘
        </Button>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          返回上一页
        </Button>
      </div>
      <Link to="/vms" className="fs-sm mt-8">
        或者去看看虚拟机列表
      </Link>
    </div>
  );
}

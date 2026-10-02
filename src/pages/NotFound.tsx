/* ==========================================================================
   ProxCenter — NotFound 404
   ========================================================================== */

import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { useT } from '../i18n';

export function NotFound() {
  const t = useT();
  const navigate = useNavigate();

  return (
    <div className="notfound">
      <div className="notfound-code">404</div>
      <h1 className="notfound-title">{t('notFound.title')}</h1>
      <p className="notfound-text">{t('notFound.text')}</p>
      <div className="flex gap-12 mt-8">
        <Button variant="primary" onClick={() => navigate('/')}>
          {t('notFound.backDashboard')}
        </Button>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          {t('notFound.backPrev')}
        </Button>
      </div>
      <Link to="/vms" className="fs-sm mt-8">
        {t('notFound.goVms')}
      </Link>
    </div>
  );
}

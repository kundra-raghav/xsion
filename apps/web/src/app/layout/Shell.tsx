import { Outlet } from 'react-router-dom';
import { Topbar } from './Topbar';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../../components/ui/Toast';
import './Shell.css';

export function Shell() {
  return (
    <div className="shell">
      <Topbar />
      <div className="shell__main">
        <Sidebar />
        <main className="shell__content">
          <Outlet />
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}

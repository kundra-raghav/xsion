import { NavLink } from 'react-router-dom';
import { FolderKanban, BarChart3 } from 'lucide-react';
import './Sidebar.css';

export function Sidebar() {
  const navItems = [
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/runs', label: 'Runs', icon: BarChart3 },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar__content">
        <nav className="sidebar__nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
              }
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </aside>
  );
}

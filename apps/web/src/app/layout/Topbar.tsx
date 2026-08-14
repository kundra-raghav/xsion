import './Topbar.css';

export function Topbar() {
  return (
    <header className="topbar">
      <div className="topbar__logo">
        <h1 className="topbar__title">Xsion</h1>
      </div>
      <div className="topbar__status">
        <span className="topbar__status-dot topbar__status-dot--disconnected" />
        <span className="topbar__status-text">Backend: Disconnected</span>
      </div>
    </header>
  );
}

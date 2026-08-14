import { useAppStore } from '../../store/useAppStore';
import { AlertCircle, CheckCircle, Info, X, AlertTriangle } from 'lucide-react';
import './Toast.css';

export function ToastContainer() {
  const toast = useAppStore((state) => state.ui.toast);
  const clearToast = useAppStore((state) => state.clearToast);

  if (!toast) return null;

  return (
    <div className="toast-container">
      <div className={`toast toast--${toast.kind}`}>
        <div className="toast__icon">
          {toast.kind === 'success' && <CheckCircle size={20} />}
          {toast.kind === 'error' && <AlertCircle size={20} />}
          {toast.kind === 'warning' && <AlertTriangle size={20} />}
          {toast.kind === 'info' && <Info size={20} />}
        </div>
        <div className="toast__message">{toast.message}</div>
        <button
          className="toast__close"
          onClick={() => clearToast()}
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

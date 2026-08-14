import { ButtonHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import './Button.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={clsx('btn', `btn--${variant}`, `btn--${size}`, isLoading && 'btn--loading', className)}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading ? <span className="btn__spinner" /> : children}
    </button>
  );
}

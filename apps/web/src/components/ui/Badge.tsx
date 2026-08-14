import { HTMLAttributes } from 'react';
import { clsx } from 'clsx';
import './Badge.css';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
}

export function Badge({ variant = 'default', className, children, ...props }: BadgeProps) {
  return (
    <span className={clsx('badge', `badge--${variant}`, className)} {...props}>
      {children}
    </span>
  );
}

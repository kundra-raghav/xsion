import { HTMLAttributes } from 'react';
import { clsx } from 'clsx';
import './Spinner.css';

interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg';
}

export function Spinner({ size = 'md', className, ...props }: SpinnerProps) {
  return (
    <div className={clsx('spinner', `spinner--${size}`, className)} {...props}>
      <div className="spinner__circle" />
    </div>
  );
}

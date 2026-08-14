import { InputHTMLAttributes, forwardRef } from 'react';
import { clsx } from 'clsx';
import './Input.css';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, className, ...props }, ref) => {
    return (
      <div className="input-wrapper">
        {label && (
          <label className="input__label" htmlFor={props.id}>
            {label}
          </label>
        )}
        <input
          ref={ref}
          className={clsx('input', error && 'input--error', className)}
          {...props}
        />
        {error && <span className="input__error">{error}</span>}
        {helperText && !error && (
          <span className="input__helper">{helperText}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

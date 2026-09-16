interface InputFieldProps {
  label: string;
  name: string;
  type?: 'text' | 'password' | 'select'|'email';
  value: string | string[];
  onChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => void;
  required?: boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  multiple?: boolean;
  disabled?: boolean; // added
}

import { useState } from 'react';

export default function InputField({
  label,
  name,
  type = 'text',
  value,
  onChange,
  required = false,
  placeholder,
  options = [],
  multiple = false,
  disabled = false,
}: InputFieldProps) {
  const [error, setError] = useState('');

  const baseClass = "border w-[400px] h-[40px] rounded-md px-2";
  const disabledClass = "bg-gray-100 text-gray-500 cursor-not-allowed";
  const errorClass = "border-red-500";

  // Validate email onChange
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    onChange(e); // pass value to parent

    if (type === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (e.target.value && !emailRegex.test(e.target.value)) {
        setError('Invalid email format');
      } else {
        setError('');
      }
    }
  };

  return (
    <div style={{ marginBottom: '12px' }}>
      <label style={{ display: 'block', marginBottom: '4px' }}>{label}</label>

      {type === 'select' ? (
        <select
          className={`${baseClass} ${disabled ? disabledClass : ''}`}
          name={name}
          value={value}
          multiple={multiple}
          onChange={handleInputChange}
          required={required}
          disabled={disabled}
        >
          {!multiple && <option value="">Select {label}</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={`${baseClass} ${disabled ? disabledClass : ''} ${error ? errorClass : ''}`}
          name={name}
          type={type}
          value={value as string}
          onChange={handleInputChange}
          required={required}
          placeholder={placeholder}
          disabled={disabled}
        />
      )}

      {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
    </div>
  );
}


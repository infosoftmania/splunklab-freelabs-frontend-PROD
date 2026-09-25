'use client';

import { useState } from 'react';

interface KeyDownloadButtonProps {
  awsAccessKey: string;
  awsSecretKey: string;
  region: string;
  keyPairName: string;
  disabled?: boolean;
}

export default function KeyDownloadButton({
  awsAccessKey,
  awsSecretKey,
  region,
  keyPairName,
  disabled = false,
}: KeyDownloadButtonProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState<boolean | null>(null);

  const handleDownload = async () => {
    if (loading || disabled) return;

    if (!awsAccessKey || !awsSecretKey || !region || !keyPairName) {
      setMessage('Please fill all AWS credentials and key pair name');
      setSuccess(false);
      return;
    }

    setLoading(true);
    setMessage('');
    setSuccess(null);

    try {
      const res = await fetch('/api/keypair-validation/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aws_access_key: awsAccessKey,
          aws_secret_key: awsSecretKey,
          region,
          key_pair_name: keyPairName,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Request failed');
      }

      if (data.keyMaterial) {
        // Download PEM file
        const blob = new Blob([data.keyMaterial], { type: 'text/plain' });
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${keyPairName}.pem`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        setMessage(`Key pair "${keyPairName}" created and downloaded successfully`);
        setSuccess(true);
      } else {
        setMessage(data.message || `Key pair "${keyPairName}" already exists`);
        setSuccess(false);
      }
    } catch (error) {
      console.error(error);
      setMessage('Error creating or downloading key pair');
      setSuccess(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 mt-3">
      <button
        type="button"
        onClick={handleDownload}
        disabled={loading || disabled}
        className={`w-[200px] px-4 py-2 rounded font-medium text-white transition-colors
          ${
            loading || disabled
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700'
          }
        `}
      >
        {loading ? 'Processing…' : 'Create'}
      </button>

      {message && (
        <p
          className={`text-sm ${
            success === true
              ? 'text-green-600'
              : success === false
              ? 'text-red-600'
              : 'text-gray-700'
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}

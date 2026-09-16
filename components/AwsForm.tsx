'use client';

import { useState } from 'react';
import InputField from './InputField';
import KeyDownloadButton from './KeyDownloadButton';
import ClusterConfigurationForm from './ClusterConfigurationForm';
import environments from '../data/environments.json';
import awsRegions from '../data/awsRegions.json';

export default function AwsForm() {
  const [selectedGroup, setSelectedGroup] = useState('');
  const [awsValid, setAwsValid] = useState<boolean | null>(null);
  const [keyPairValid, setKeyPairValid] = useState<boolean | null>(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [isClusterConfigurationOpen, setIsClusterConfigurationOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidating, setIsValidating] = useState(false);

  const [awsAccessMessage, setAwsAccessMessage] = useState('');
  const [awsSecretMessage, setAwsSecretMessage] = useState('');
  const [keyPairMessage, setKeyPairMessage] = useState('');
  const [keyPairsLoading, setKeyPairsLoading] = useState(false);
  const [isEmailValid, setIsEmailValid] = useState(false);


  const [keyPairsList, setKeyPairsList] = useState<string[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);


  const [vpcMessage, setVpcMessage] = useState('');
  const [vpcChecking, setVpcChecking] = useState(false);
  const [vpcAllowed, setVpcAllowed] = useState<boolean | null>(null);
  type VpcCheckStatus = 'idle' | 'loading' | 'success' | 'error';

  const [vpcStatus, setVpcStatus] = useState<VpcCheckStatus>('idle'); // Holds message about VPC availability


  const [formData, setFormData] = useState({
    aws_access_key: '',
    aws_secret_key: '',
    region: '',
    key_pair_name: '',
    user_name: '',
    codebuild_projects: [] as string[],
  });

  const codebuildGroupOptions = Object.entries(environments).map(
  ([key, value]) => ({
    label: value.label,
    value: key,
  })
);


  // -------------------------
  // Input handlers
  // -------------------------
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
  const { name, value } = e.target;

  setFormData(prev => ({ ...prev, [name]: value }));

  // AWS fields reset
  if (['aws_access_key', 'aws_secret_key', 'region'].includes(name)) {
    setAwsValid(null);
    setKeyPairValid(null);
  }

  if (name === 'key_pair_name') {
    setKeyPairValid(null);
  }

  // Validate email
  if (name === 'user_name') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    setIsEmailValid(emailRegex.test(value));
  }
};

  // -------------------------
  // Region change -> fetch key pairs
  // -------------------------
 const handleRegionChange = async (
  e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) => {
  const region = e.target.value;

  setFormData(prev => ({
    ...prev,
    region,
    key_pair_name: '',
  }));

  setKeyPairsList([]);
  setShowDropdown(false);
  setKeyPairMessage('');
  setKeyPairValid(null);

  if (!formData.aws_access_key || !formData.aws_secret_key) return;

  setKeyPairsLoading(true);

  try {
    const res = await fetch('/api/list-keypairs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aws_access_key: formData.aws_access_key,
        aws_secret_key: formData.aws_secret_key,
        region,
      }),
    });
    const data = await res.json();

    if (data.success) {
      setKeyPairsList(data.keyPairs || []);
    }
  } catch (err) {
    console.error('Failed to fetch key pairs', err);
  } finally {
    setKeyPairsLoading(false);
  }
};


const handleGroupChange = async (
  e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) => {
  const groupKey = e.target.value;

  setSelectedGroup(groupKey);
  setVpcMessage('');
  setVpcStatus('idle');

  const env = environments[groupKey as keyof typeof environments];
  if (!env) return;

  const { aws_access_key, aws_secret_key, region } = formData;

  if (!aws_access_key || !aws_secret_key || !region) {
    setVpcStatus('error');
    setVpcMessage('AWS credentials or region not verified.');
    return;
  }

  setFormData(prev => ({
    ...prev,
    codebuild_projects: env.codebuild_projects,
  }));

  try {
    setVpcStatus('loading');

    const res = await fetch('/api/validate-vpc-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aws_access_key,
        aws_secret_key,
        region,
        requiredVpcs: env.requiredVpcs,
      }),
    });

    const data = await res.json();

    if (!data.allowed) {
      setVpcStatus('error');
      setVpcMessage(
        `You don’t have enough VPC capacity in this region. Used: ${data.currentVpcCount}, Limit: ${data.vpcLimit}, Required: ${data.requiredVpcs}.`
      );

      setSelectedGroup('');
      setFormData(prev => ({ ...prev, codebuild_projects: [] }));
      return;
    }

    // ✅ success
    setVpcStatus('success');
    setVpcMessage('VPC capacity check passed. You can proceed.');

  } catch (err) {
    console.error(err);
    setVpcStatus('error');
    setVpcMessage('Error checking VPC capacity.');
  }
};




  // -------------------------
  // Validate AWS Access Key & Secret Key
  // -------------------------
  const validateAws = async () => {
    if (!formData.aws_access_key || !formData.aws_secret_key) return;

    setIsValidating(true);
    setAwsAccessMessage('');
    setAwsSecretMessage('');
    setKeyPairMessage('');

    try {
      const res = await fetch('/api/validate-aws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          aws_access_key: formData.aws_access_key,
          aws_secret_key: formData.aws_secret_key,
        }),
      });

      const data = await res.json();

      if (data.awsValid) {
        setAwsAccessMessage('AWS Access Key is valid');
        setAwsSecretMessage('AWS Secret Key is valid');
      } else {
        setAwsAccessMessage('Invalid AWS Access Key');
        setAwsSecretMessage('Invalid AWS Secret Key');
      }

      setAwsValid(data.awsValid);

    } catch (err) {
      console.error(err);
      setAwsAccessMessage('Error validating AWS Access Key');
      setAwsSecretMessage('Error validating AWS Secret Key');
      setAwsValid(false);
    } finally {
      setIsValidating(false);
    }
  };

  // -------------------------
  // Submit form
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  if (awsValid !== true) {
    setSuccessMessage('❌ Please validate AWS credentials first');
    return;
  }

  setIsSubmitting(true);
  setSuccessMessage('');

  try {
    const res = await fetch('/api/submit-form', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    const data = await res.json();

    if (!res.ok) {
      setSuccessMessage(` ${data.message || 'Request failed'}`);
      return;
    }

    setSuccessMessage(`✅ ${data.message}`);

  } catch (err) {
    console.error(err);
    setSuccessMessage('❌ Network or server error');
  } finally {
    setIsSubmitting(false);
  }
};




  // -------------------------
  // UI
  // -------------------------
  return (
    <>
      <button
        type="button"
        onClick={() => setIsClusterConfigurationOpen(true)}
        className="fixed right-4 top-4 z-40 rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow hover:bg-blue-700"
      >
        Cluster Configuration
      </button>
    <form onSubmit={handleSubmit} className="bg-white p-9 rounded shadow space-y-3">
      {/* AWS Access Key */}
      {/* AWS Access Key */}
<div className="items-center gap-2">
  <InputField
    label="AWS Access Key"
    name="aws_access_key"
    value={formData.aws_access_key}
    onChange={handleChange}
    required
    disabled={awsValid === true} // disable after successful validation
  />
  {awsAccessMessage && (
    <p className={`text-sm ${awsValid ? 'text-green-600' : 'text-red-600'}`}>
      {awsAccessMessage}
    </p>
  )}
</div>

{/* AWS Secret Key */}
<div className="items-center gap-2">
  <InputField
    label="AWS Secret Key"
    name="aws_secret_key"
    type="password"
    value={formData.aws_secret_key}
    onChange={handleChange}
    required
    disabled={awsValid === true} // disable after successful validation
  />
  {awsSecretMessage && (
    <p className={`text-sm ${awsValid ? 'text-green-600' : 'text-red-600'}`}>
      {awsSecretMessage}
    </p>
  )}
</div>


      <button
        type="button"
        disabled={isValidating}
        onClick={validateAws}
        className={`px-3 py-2 rounded text-white font-medium ${isValidating ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'}`}
      >
        {isValidating ? 'Validating...' : 'Validate AWS'}
      </button>

      {/* AWS Region */}
      <div className="items-center gap-2">
        <InputField
          label="AWS Region"
          name="region"
          type="select"
          value={formData.region}
          onChange={handleRegionChange}
          options={awsRegions.map(r => ({ label: r, value: r }))}
          required
        />
      </div>

      {/* PEM Key */}
      {/* PEM Key (show ONLY after region is selected) */}
{/* PEM Key section — show ONLY after region is selected */}
{formData.region && (
  <>
    <div className="relative w-[400px]">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        PEM Key Name
      </label>

      <input
        type="text"
        name="key_pair_name"
        value={
          keyPairsLoading ? 'Loading key pairs…' : formData.key_pair_name
        }
        onChange={handleChange}
        placeholder="Select or enter PEM key name"
        disabled={keyPairsLoading}
        className={`mt-1 block w-full h-[48px] rounded-md shadow-sm px-3 pr-10 text-sm
          ${
            keyPairsLoading
              ? 'bg-gray-100 cursor-not-allowed border-gray-300'
              : 'border border-gray-300'
          }
        `}
        onFocus={() => !keyPairsLoading && setShowDropdown(true)}
        autoComplete="off"
        required
      />

      {/* Loading spinner */}
      {keyPairsLoading && (
        <div className="absolute right-3 top-12 -translate-y-1/2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
        </div>
      )}

      {/* Dropdown arrow */}
      {!keyPairsLoading && keyPairsList.length > 0 && (
        <button
          type="button"
          className="absolute right-2 top-12 -translate-y-1/2 text-gray-500 hover:text-gray-700"
          onClick={() => setShowDropdown(prev => !prev)}
        >
          ▼
        </button>
      )}

      {/* Dropdown list */}
      {!keyPairsLoading && showDropdown && keyPairsList.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full max-h-48 overflow-auto rounded-md border border-gray-300 bg-white shadow-lg">
          {keyPairsList.map((kp) => (
            <li
              key={kp}
              className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
              onMouseDown={() => {
                setFormData(prev => ({
                  ...prev,
                  key_pair_name: kp,
                }));
                setShowDropdown(false);
              }}
            >
              {kp}
            </li>
          ))}
        </ul>
      )}

      {/* Status message */}
      {keyPairMessage && (
        <p
          className={`mt-1 text-sm ${
            keyPairValid ? 'text-green-600' : 'text-red-600'
          }`}
        >
          {keyPairMessage}
        </p>
      )}
    </div>

    {/* Create / Download button */}
    <KeyDownloadButton
      awsAccessKey={formData.aws_access_key}
      awsSecretKey={formData.aws_secret_key}
      region={formData.region}
      keyPairName={formData.key_pair_name}
      disabled={keyPairsLoading}
    />
  </>
)}



      {/* CodeBuild Group */}
      <InputField
        label="Environments"
        name="codebuild_group"
        type="select"
        value={selectedGroup}
        onChange={handleGroupChange}
        options={codebuildGroupOptions}
        required
      />



      {/* VPC validation loading */}
{vpcChecking && (
  <p className="text-sm text-blue-600 mt-1">⏳ Checking VPC capacity...</p>
)}

{/* VPC validation message */}
{/* VPC Capacity Check Indicator */}
{vpcStatus !== 'idle' && (
  <div className="flex items-start gap-3 mt-2">
    <input
      type="checkbox"
      checked={vpcStatus === 'success'}
      disabled
      className="mt-1 h-4 w-4 cursor-not-allowed"
    />

    <div>
      {vpcStatus === 'loading' && (
        <p className="text-sm text-blue-600"> Checking VPC capacity…</p>
      )}

      {vpcStatus === 'success' && (
        <p className="text-sm text-green-600"> {vpcMessage}</p>
      )}

      {vpcStatus === 'error' && (
        <p className="text-sm text-red-600"> {vpcMessage}</p>
      )}
    </div>
  </div>
)}



      {/* Email */}
      <InputField
        label="Email"
        name="user_name"
        type='email'
        value={formData.user_name}
        onChange={handleChange}
        required
        placeholder='Enter your email'
      />

      {/* Submit Button */}
      <button
  type="submit"
  disabled={
    isSubmitting ||
    awsValid !== true ||
    vpcStatus !== 'success' ||
    !isEmailValid
  }
  className={`border w-[400px] mt-2 py-3 rounded-lg text-lg font-semibold text-white
    ${
      isSubmitting || awsValid !== true || vpcStatus !== 'success' || !isEmailValid
        ? 'bg-gray-400 cursor-not-allowed'
        : 'bg-black hover:bg-gray-800'
    }`}
>
  {isSubmitting ? 'Submitting...' : 'Submit'}
</button>



      {successMessage && (
  <p
    className={`text-center mt-2 ${
      successMessage.startsWith('✅') ? 'text-green-600' : 'text-red-600'
    }`}
  >
    {successMessage}
  </p>
)}

    </form>
      {isClusterConfigurationOpen && (
        <ClusterConfigurationForm
          onClose={() => setIsClusterConfigurationOpen(false)}
        />
      )}
    </>
  );
}

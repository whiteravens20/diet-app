import { Settings } from 'lucide-react';
import { PagePlaceholder } from '@/components/page-placeholder';

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      icon={Settings}
      description="Account settings and AI provider configuration (BYOK keys)."
      endpoints={['GET /api/ai/providers', 'PUT /api/ai/providers', 'DELETE /api/ai/providers/:id']}
    />
  );
}

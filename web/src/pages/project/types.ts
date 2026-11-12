import type { MemberRole, ProjectBundle } from '../../api'

export interface ProjectTabProps {
  project: ProjectBundle
  role: MemberRole
  refresh: () => void
  onNavigate: (tab: string) => void
}

export const canMaintain = (role: MemberRole): boolean => role === 'owner' || role === 'maintainer'
export const isOwner = (role: MemberRole): boolean => role === 'owner'

export const policyLabel = (value: string): string => {
  if (value === 'required') return '需要审批'
  if (value === 'auto') return '自动执行'
  return value
}

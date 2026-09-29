// 内联 SVG 图标（不引入图标库）。统一 24×24 视窗、1.5 描边，颜色跟随 currentColor。
import type { ReactNode, SVGProps } from 'react'

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

function Icon({ size = 24, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function HomeIcon({ filled, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...rest} fill={filled ? 'currentColor' : 'none'}>
      <path d="M3.5 10.4 12 3.8l8.5 6.6V19a1.6 1.6 0 0 1-1.6 1.6h-4.3v-5.7H9.4v5.7H5.1A1.6 1.6 0 0 1 3.5 19z" />
    </Icon>
  )
}

export function UserIcon({ filled, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...rest}>
      <circle cx="12" cy="8" r="3.7" fill={filled ? 'currentColor' : 'none'} />
      <path
        d="M4.8 20.2c0-3.5 3.2-5.6 7.2-5.6s7.2 2.1 7.2 5.6"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Icon>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 4 4" />
    </Icon>
  )
}

export function HeartIcon({ filled, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...rest} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 20s-7.2-4.4-7.2-9.3A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 7.2 2.7C19.2 15.6 12 20 12 20z" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </Icon>
  )
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Icon>
  )
}

export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16.5 4.6a2 2 0 0 1 2.9 2.9L8 18.9l-3.8.9.9-3.8z" />
      <path d="m14.8 6.3 2.9 2.9" />
    </Icon>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7h15M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" />
      <path d="M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.5 11v5M13.5 11v5" />
    </Icon>
  )
}

export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.8" y="4.8" width="16.4" height="14.4" rx="2.2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17.5 4.4-4.2 3.4 3.1 3-2.6 4.2 4" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.8 4.6 4.4L19 6.8" />
    </Icon>
  )
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 15 6-6 6 6" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

export function BookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 5.4A1.9 1.9 0 0 1 6.4 3.5h11.1a1 1 0 0 1 1 1v14.1a1 1 0 0 1-1 1H6.4a1.9 1.9 0 0 0-1.9 1.9z" />
      <path d="M4.5 5.4v15.1M8.5 8h6" />
    </Icon>
  )
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 3.5 11.2 12.8" />
      <path d="M20.5 3.5 14.4 20.5l-3.2-7.7-7.7-3.2z" />
    </Icon>
  )
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M18.9 14.3a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.14a1.8 1.8 0 0 1-3.6 0v-.07a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05a1.8 1.8 0 1 1-2.55-2.55l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9H4.2a1.8 1.8 0 0 1 0-3.6h.07a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05A1.8 1.8 0 1 1 7.84 4.6l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37V3.4a1.8 1.8 0 0 1 3.6 0v.07a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.14a1.8 1.8 0 0 1 0 3.6h-.07a1.5 1.5 0 0 0-1.37.9z" />
    </Icon>
  )
}

export function PinIcon({ filled, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...rest} fill={filled ? 'currentColor' : 'none'}>
      <path d="M9.2 3.8h5.6" />
      <path d="M10.4 3.8v5.3L7.3 12.4h9.4l-3.1-3.3V3.8" />
      <path d="M12 12.4V20.2" />
    </Icon>
  )
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 12.5c0 3.7-3.6 6.7-8 6.7a9.6 9.6 0 0 1-2.6-.35L5.2 20.3l1.1-3.2A6.4 6.4 0 0 1 4 12.5c0-3.7 3.6-6.7 8-6.7s8 3 8 6.7z" />
    </Icon>
  )
}

/** API 配置：插头（表示「接到服务商」） */
export function PlugIcon({ filled, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...rest} fill={filled ? 'currentColor' : 'none'}>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v2.7a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 15.7v4.8" />
    </Icon>
  )
}

/** 刷新 / 重新获取（顺时针带箭头的圆） */
export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 11.5a8 8 0 1 0-.9 5" />
      <path d="M20.5 4.5v5h-5" />
    </Icon>
  )
}

/** 复制（两张叠在一起的纸） */
export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </Icon>
  )
}

/** 创建分支（一条线岔成两条） */
export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="5.6" r="2.3" />
      <circle cx="7" cy="18.4" r="2.3" />
      <circle cx="17" cy="12" r="2.3" />
      <path d="M7 7.9v8.2" />
      <path d="M9.3 5.6h3.4a2 2 0 0 1 2 2V9.7" />
    </Icon>
  )
}

/** 撤回（往回拐的箭头，RefreshIcon 的反向） */
export function UndoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12.5a8 8 0 1 1 .9 4.5" />
      <path d="M3.5 5.5v5h5" />
    </Icon>
  )
}

/** 调节参数（三条横线，各带一个滑块） */
export function SlidersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h4" />
      <path d="M12 7h8" />
      <circle cx="10" cy="7" r="2" />
      <path d="M4 12h10" />
      <path d="M18 12h2" />
      <circle cx="16" cy="12" r="2" />
      <path d="M4 17h2" />
      <path d="M10 17h10" />
      <circle cx="8" cy="17" r="2" />
    </Icon>
  )
}

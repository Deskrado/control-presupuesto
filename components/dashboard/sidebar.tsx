'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { 
  LayoutDashboard, 
  ArrowUpDown, 
  CreditCard, 
  FolderOpen, 
  PiggyBank, 
  TrendingUp, 
  Settings,
  ChevronLeft,
  ChevronRight,
  Wallet,
  RefreshCw,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useFamilyVisibility } from '@/components/dashboard/use-dashboard-data'
import { canSeeModule } from '@/lib/family-visibility'

const navigation = [
  { module: 'dashboard', name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { module: 'transactions', name: 'Transacciones', href: '/dashboard/transacciones', icon: ArrowUpDown },
  { module: 'transactions', name: 'Recurrentes', href: '/dashboard/recurrentes', icon: RefreshCw },
  { module: 'credit_cards', name: 'Tarjetas', href: '/dashboard/tarjetas', icon: CreditCard },
  { module: 'categories', name: 'Categorías', href: '/dashboard/categorias', icon: FolderOpen },
  { module: 'investments', name: 'Inversiones', href: '/dashboard/inversiones', icon: TrendingUp },
  { module: 'savings', name: 'Ahorros', href: '/dashboard/ahorros', icon: PiggyBank },
  { module: 'projections', name: 'Proyección', href: '/dashboard/proyeccion', icon: Wallet },
  { module: 'settings', name: 'Configuración', href: '/dashboard/configuracion', icon: Settings },
]

export function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const { data: visibility } = useFamilyVisibility()
  const visibleNavigation = navigation.filter((item) =>
    canSeeModule(item.module, visibility?.membership, visibility?.permissions),
  )

  return (
    <>
      <aside
        className={cn(
          'hidden flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-all duration-300 md:flex',
          collapsed ? 'w-16' : 'w-64'
        )}
      >
        <div className="flex items-center justify-between p-4 border-b border-sidebar-border">
          {!collapsed && (
            <h1 className="text-lg font-semibold truncate">Control de Gastos</h1>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(!collapsed)}
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground shrink-0"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        <nav className="flex-1 p-2 space-y-1">
          {visibleNavigation.map((item) => {
            const isActive = item.href === '/dashboard'
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`)

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  collapsed && 'justify-center px-2'
                )}
                title={collapsed ? item.name : undefined}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                {!collapsed && <span>{item.name}</span>}
              </Link>
            )
          })}
        </nav>
      </aside>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 shadow-lg backdrop-blur md:hidden">
        <div className="flex gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {visibleNavigation.map((item) => {
            const isActive = item.href === '/dashboard'
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`)

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex min-w-[72px] flex-col items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <item.icon className="h-5 w-5 shrink-0" />
                <span className="max-w-[68px] truncate">{item.name}</span>
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}

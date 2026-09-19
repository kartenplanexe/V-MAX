interface MaxWebApp {
  readonly deviceName?: string;
  readonly initData?: string;
  readonly platform?: 'ios' | 'android' | 'desktop' | 'web' | string;
  readonly version?: string;
  getViewportSize?: () => Promise<{ height: string; width: string }>;
}

interface Window {
  WebApp?: MaxWebApp;
}

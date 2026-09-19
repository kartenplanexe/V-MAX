export interface AuthenticatedMaxUser {
  id: number;
  firstName: string;
  languageCode?: string;
}

export interface MaxAuthSuccess {
  status: 'authenticated';
  authDate: number;
  user: AuthenticatedMaxUser;
}

export interface ApiError {
  status: 'error';
  code: string;
  message: string;
}

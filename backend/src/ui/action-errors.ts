import { data, isRouteErrorResponse } from 'react-router';

export interface FormActionData {
  formError: string;
}

/**
 * Keep expected action failures beside their form instead of replacing the
 * workspace with the route error boundary. Authorization and unexpected
 * failures still retain their HTTP status codes.
 */
export async function keepFormError<T>(operation: () => Promise<T>): Promise<T | ReturnType<typeof data>> {
  try {
    return await operation();
  } catch (error) {
    if (isRouteErrorResponse(error)) {
      const message = typeof error.data === 'string' ? error.data : error.statusText;
      return data({ formError: message || 'The change could not be saved. Please try again.' }, { status: error.status });
    }
    // During server-side static handling, React Router exposes a thrown
    // data(...) value before it has been converted into ErrorResponse.
    const thrown = error as { data?: unknown; init?: ResponseInit } | null;
    const status = thrown?.init?.status;
    if (thrown && typeof status === 'number') {
      const message = typeof thrown.data === 'string' ? thrown.data : 'The change could not be saved. Please try again.';
      return data({ formError: message }, { status });
    }
    return data({ formError: 'The change could not be saved. Please try again.' }, { status: 500 });
  }
}

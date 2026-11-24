export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

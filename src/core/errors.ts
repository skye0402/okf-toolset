export class OkfError extends Error {
  constructor(message: string, readonly code: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OkfError';
  }
}

export class OkfPathError extends OkfError {
  constructor(message: string, causeValue?: unknown) {
    super(message, 'OKF_PATH_ERROR', causeValue);
    this.name = 'OkfPathError';
  }
}

export class OkfGitError extends OkfError {
  constructor(message: string, causeValue?: unknown) {
    super(message, 'OKF_GIT_ERROR', causeValue);
    this.name = 'OkfGitError';
  }
}

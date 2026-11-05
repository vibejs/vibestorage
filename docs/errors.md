# Error codes

These codes belong to `@usevibejs/storage`. They are not vibe.js framework codes.

| Code                        | Meaning                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `STORAGE_INVALID_CONFIG`    | Thrown when limits, a driver, a secret, an endpoint, or `expiresIn` is unusable.                   |
| `STORAGE_INVALID_KEY`       | Thrown when a key is absolute, empty, or contains a `.` or `..` segment, or an upload repeats one. |
| `STORAGE_TYPE_REJECTED`     | Thrown when a media type is outside `types`. Checked before the driver.                            |
| `STORAGE_TOO_LARGE`         | Thrown when one object or an upload's total bytes exceed `maxBytes`. Checked before the driver.    |
| `STORAGE_TOO_MANY`          | Thrown when `upload` receives more than `maxFiles` files. Checked before the driver.               |
| `STORAGE_NOT_FOUND`         | Thrown when `get` finds no object. `delete` of a missing key does not use this code.               |
| `STORAGE_INVALID_SIGNATURE` | Thrown when `verifyLocalRead` rejects a local signed URL. S3 and R2 check their own URLs.          |
| `STORAGE_DRIVER_FAILED`     | Thrown when a driver or the S3 HTTP API fails. The original error is `cause` when there is one.    |

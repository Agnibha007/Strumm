# Cobalt API attribution and license

Strumm's API container includes the unmodified Cobalt API from:

- Project: https://github.com/imputnet/cobalt
- Pinned source revision: `a636575b09de1fc55d9b8cd98cac88f5f2f16b42`
- License: GNU Affero General Public License v3.0 (AGPL-3.0)
- License text: https://github.com/imputnet/cobalt/blob/a636575b09de1fc55d9b8cd98cac88f5f2f16b42/api/LICENSE

Strumm runs Cobalt as a separate internal service and communicates with its documented HTTP API. No Cobalt source files are modified by this integration. The Cobalt source revision is fetched during the Docker build and its Git metadata is retained in the runtime image.

Cobalt remains a third-party component. Review its AGPL-3.0 obligations before offering the integrated service commercially or making changes to the Cobalt source.

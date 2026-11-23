# TypeRB Go

The Go implementation of [TypeRB](https://github.com/type-rb/type-rb) compiles
TypeRB projects to Go, Ruby, and TypeScript. Its command is `trbg`.

Install the companion with Homebrew:

```sh
brew install type-rb/tap/trbg
trbg --version
```

Prebuilt binaries and checksums are also available from
[GitHub Releases](https://github.com/type-rb/type-rb-go/releases). To install
the exact v0.5.0-alpha.1 version from Go source:

```sh
go install github.com/type-rb/type-rb-go/cmd/trbg@v0.5.0-alpha.1
```

See the [TypeRB documentation](https://type-rb.github.io/docs/) for the
language, configuration, official packages, and editor setup. Use `trbg` to
run examples that require the Go implementation.

For development, run `go test ./...` with the Go version in `go.mod`.
The [v0.5 transition contract](https://github.com/type-rb/type-rb/blob/main/docs/native-transition.md)
describes the shared feature and release requirements.

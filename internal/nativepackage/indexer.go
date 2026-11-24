package nativepackage

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/type-rb/type-rb-go/internal/project"
)

type indexRequest struct {
	Modules           []string `json:"modules"`
	TypeScriptVersion string   `json:"typescriptVersion"`
}

type indexResult struct {
	TypeScriptVersion string            `json:"typescriptVersion"`
	Modules           map[string]Module `json:"modules"`
}

func Generate(root, packageManager string, dependencies map[string]string) (*Catalog, error) {
	modules := make([]string, 0, len(dependencies))
	for name := range dependencies {
		modules = append(modules, name)
	}
	return GenerateModules(root, packageManager, dependencies, modules)
}

func GenerateModules(root, packageManager string, dependencies map[string]string, requestedModules []string) (*Catalog, error) {
	catalog := Empty(dependencies)
	if len(dependencies) == 0 {
		return catalog, nil
	}
	seen := map[string]bool{}
	modules := make([]string, 0, len(dependencies)+len(requestedModules))
	for name := range dependencies {
		seen[name] = true
		modules = append(modules, name)
	}
	for _, name := range requestedModules {
		if !seen[name] && catalog.Owns(name) {
			seen[name] = true
			modules = append(modules, name)
		}
	}
	sort.Strings(modules)
	requestData, err := json.Marshal(indexRequest{Modules: modules, TypeScriptVersion: project.DefaultTypeScriptVersion})
	if err != nil {
		return nil, err
	}
	temporaryDirectory, err := os.MkdirTemp("", "trb-native-types-*")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(temporaryDirectory) }()
	scriptPath := filepath.Join(temporaryDirectory, "index.mjs")
	requestPath := filepath.Join(temporaryDirectory, "request.json")
	if err := os.WriteFile(scriptPath, []byte(typeScriptIndexer), 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(requestPath, requestData, 0o600); err != nil {
		return nil, err
	}
	var command *exec.Cmd
	switch packageManager {
	case "bun":
		command = exec.Command("bun", scriptPath, requestPath)
	case "npm":
		command = exec.Command("node", scriptPath, requestPath)
	default:
		return nil, fmt.Errorf("unsupported TypeScript package manager %q", packageManager)
	}
	command.Dir = root
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("index native TypeScript package types: %s", message)
	}
	decoder := json.NewDecoder(&stdout)
	decoder.DisallowUnknownFields()
	var result indexResult
	if err := decoder.Decode(&result); err != nil {
		return nil, fmt.Errorf("decode native TypeScript package indexer output: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("decode native TypeScript package indexer output: trailing JSON content")
	}
	catalog.TypeScriptVersion = result.TypeScriptVersion
	catalog.Modules = result.Modules
	return catalog, nil
}

//go:embed indexer.mjs
var typeScriptIndexer string

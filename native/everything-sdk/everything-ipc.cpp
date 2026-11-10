#include <windows.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#define EVERYTHINGUSERAPI
#include "include/Everything.h"

namespace {

constexpr DWORD kDefaultLimit = 1000;
constexpr DWORD kMaxLimit = 5000;

std::string toUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string output(bytes, '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), &output[0], bytes, nullptr, nullptr);
  return output;
}

std::string jsonString(const std::string& value) {
  std::string output = "\"";
  for (unsigned char byte : value) {
    switch (byte) {
      case '\\': output += "\\\\"; break;
      case '"': output += "\\\""; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (byte < 0x20) {
          char buffer[7]{};
          sprintf_s(buffer, "\\u%04x", byte);
          output += buffer;
        } else {
          output.push_back(static_cast<char>(byte));
        }
    }
  }
  output += "\"";
  return output;
}

std::string fileTimeToJson(FILETIME time) {
  ULARGE_INTEGER value{};
  value.LowPart = time.dwLowDateTime;
  value.HighPart = time.dwHighDateTime;
  constexpr ULONGLONG kWindowsEpoch = 116444736000000000ULL;
  if (value.QuadPart < kWindowsEpoch) return "0";
  return std::to_string((value.QuadPart - kWindowsEpoch) / 10000ULL);
}

void printError(const char* action) {
  std::fprintf(stderr, "everything-ipc: %s failed (error %lu)\n", action, static_cast<unsigned long>(Everything_GetLastError()));
}

int status() {
  const BOOL loaded = Everything_IsDBLoaded();
  if (!loaded) {
    printError("IPC status");
    return 8;
  }
  std::printf("{\"ready\":true,\"major\":%lu}\n", static_cast<unsigned long>(Everything_GetMajorVersion()));
  Everything_CleanUp();
  return 0;
}

int runQuery(const std::wstring& query, DWORD limit, bool pathOnly);

int search(int argc, wchar_t** argv) {
  DWORD limit = kDefaultLimit;
  bool json = false;
  bool pathOnly = false;
  std::vector<std::wstring> queryParts;
  for (int index = 1; index < argc; ++index) {
    const std::wstring argument = argv[index];
    if (argument == L"--json" || argument == L"-json") {
      json = true;
    } else if (argument == L"--path-only") {
      pathOnly = true;
    } else if ((argument == L"-n" || argument == L"--max") && index + 1 < argc) {
      limit = std::min<DWORD>(kMaxLimit, std::max<DWORD>(1, _wtoi(argv[++index])));
    } else if (argument != L"-no-header") {
      queryParts.push_back(argument);
    }
  }
  if (!json) {
    std::fprintf(stderr, "everything-ipc: only JSON output is supported\n");
    return 4;
  }

  std::wstring query;
  for (size_t index = 0; index < queryParts.size(); ++index) {
    if (index > 0) query += L" ";
    query += queryParts[index];
  }
  return runQuery(query, limit, pathOnly);
}

std::wstring fromUtf8(const std::string& value) {
  if (value.empty()) return {};
  const int chars = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (chars <= 0) return {};
  std::wstring result(static_cast<size_t>(chars), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &result[0], chars);
  return result;
}

// --serve keeps one process alive and answers one query per stdin line:
//   "<limit>\t<pathOnly 0|1>\t<query>"  ->  one JSON line on stdout.
// Starting a new helper per search cost 0.4-2.5 s on PCs where security
// software inspects every process launch; a resident helper avoids that.
int serve() {
  std::vector<char> line(65536);
  while (std::fgets(line.data(), static_cast<int>(line.size()), stdin)) {
    std::string request(line.data());
    while (!request.empty() && (request.back() == '\n' || request.back() == '\r')) request.pop_back();
    const size_t first = request.find('\t');
    const size_t second = first == std::string::npos ? std::string::npos : request.find('\t', first + 1);
    if (second == std::string::npos) {
      std::printf("{\"error\":\"bad request\"}\n");
    } else {
      const DWORD limit = std::min<DWORD>(kMaxLimit, std::max<DWORD>(1, static_cast<DWORD>(std::atoi(request.substr(0, first).c_str()))));
      const bool pathOnly = request.substr(first + 1, second - first - 1) == "1";
      if (runQuery(fromUtf8(request.substr(second + 1)), limit, pathOnly) != 0) {
        std::printf("{\"error\":\"ipc\"}\n");
      }
    }
    std::fflush(stdout);
  }
  return 0;
}

int runQuery(const std::wstring& query, DWORD limit, bool pathOnly) {
  Everything_SetSearchW(query.c_str());
  Everything_SetMax(limit);
  Everything_SetOffset(0);
  Everything_SetSort(EVERYTHING_SORT_NAME_ASCENDING);
  // Size, date and attributes are not always in Everything's database (for
  // example network folder indexes), so requesting them makes Everything stat
  // each result over the network. --path-only skips that; the caller fills in
  // metadata for local results itself.
  Everything_SetRequestFlags(pathOnly
    ? EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME
    : EVERYTHING_REQUEST_FILE_NAME |
      EVERYTHING_REQUEST_PATH |
      EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME |
      EVERYTHING_REQUEST_SIZE |
      EVERYTHING_REQUEST_DATE_MODIFIED |
      EVERYTHING_REQUEST_ATTRIBUTES
  );

  if (!Everything_QueryW(TRUE)) {
    printError("IPC query");
    Everything_CleanUp();
    return 8;
  }

  const DWORD count = std::min<DWORD>(Everything_GetNumResults(), limit);
  const DWORD total = Everything_GetTotResults();
  std::printf("{\"total\":%lu,\"items\":[", static_cast<unsigned long>(total));
  std::vector<wchar_t> pathBuffer(32768);
  for (DWORD index = 0; index < count; ++index) {
    if (index > 0) std::printf(",");
    const DWORD length = Everything_GetResultFullPathNameW(index, pathBuffer.data(), static_cast<DWORD>(pathBuffer.size()));
    const std::wstring fullPath(pathBuffer.data(), length);
    const bool isDir = Everything_IsFolderResult(index) == TRUE;
    if (pathOnly) {
      std::printf("{\"path\":%s,\"size\":null,\"date_modified\":null,\"is_dir\":%s}",
        jsonString(toUtf8(fullPath)).c_str(),
        isDir ? "true" : "false");
      continue;
    }
    LARGE_INTEGER size{};
    FILETIME modified{};
    const bool hasSize = Everything_GetResultSize(index, &size) == TRUE;
    const bool hasModified = Everything_GetResultDateModified(index, &modified) == TRUE;
    const DWORD attributes = Everything_GetResultAttributes(index);
    std::printf("{\"path\":%s,\"size\":%lld,\"date_modified\":%s,\"is_dir\":%s}",
      jsonString(toUtf8(fullPath)).c_str(),
      hasSize ? size.QuadPart : 0LL,
      hasModified ? fileTimeToJson(modified).c_str() : "0",
      (isDir || (attributes & FILE_ATTRIBUTE_DIRECTORY)) ? "true" : "false");
  }
  std::printf("],\"more\":%s,\"volumes_incomplete\":false}\n", count < total ? "true" : "false");
  Everything_CleanUp();
  return 0;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc > 1 && std::wstring(argv[1]) == L"--version") {
    std::printf("everything-ipc 1.0 (Voidtools Everything SDK IPC)\n");
    return 0;
  }
  if (argc > 1 && std::wstring(argv[1]) == L"--status") return status();
  if (argc > 1 && std::wstring(argv[1]) == L"--serve") return serve();
  return search(argc, argv);
}

#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    static const char *python = "/usr/lib/josi-ce-server-setup/runtime/python/bin/python3.12";
    static const char *lifecycle = "/usr/lib/josi-ce-server-setup/runtime/app/native/lifecycle.py";
    if (geteuid() != 0 || argc != 3 || strcmp(argv[1], "install") != 0) {
        fputs("Unsupported Josi setup operation.\n", stderr); return 2;
    }
    errno = 0; char *end = NULL; unsigned long uid = strtoul(argv[2], &end, 10);
    if (errno || !end || *end || uid < 1000 || uid > INT_MAX) {
        fputs("Invalid logged-in user.\n", stderr); return 2;
    }
    char *const clean_env[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", NULL};
    char *const arguments[] = {(char *)python, "-I", "-B", (char *)lifecycle, "install", argv[2], NULL};
    execve(python, arguments, clean_env);
    fputs("Josi setup runtime could not start.\n", stderr); return 127;
}

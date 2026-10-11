#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static const unsigned char magic[8] = {'J','O','S','I','A','P','P','1'};

static int copy_bytes(int source, int target, uint64_t count) {
    unsigned char buffer[1024 * 1024];
    while (count) {
        size_t wanted = count < sizeof buffer ? (size_t)count : sizeof buffer;
        ssize_t got = read(source, buffer, wanted);
        if (got <= 0) return -1;
        ssize_t offset = 0;
        while (offset < got) {
            ssize_t sent = write(target, buffer + offset, (size_t)(got - offset));
            if (sent <= 0) return -1;
            offset += sent;
        }
        count -= (uint64_t)got;
    }
    return 0;
}

int main(int argc, char **argv) {
    (void)argc;
    char executable[4096];
    ssize_t length = readlink("/proc/self/exe", executable, sizeof executable - 1);
    if (length <= 0 || length >= (ssize_t)sizeof executable - 1) {
        fputs("Josi installer: cannot resolve executable\n", stderr); return 1;
    }
    executable[length] = '\0';
    int source = open(executable, O_RDONLY | O_CLOEXEC);
    struct stat info;
    unsigned char trailer[16];
    if (source < 0 || fstat(source, &info) || info.st_size < 16 ||
        lseek(source, info.st_size - 16, SEEK_SET) < 0 || read(source, trailer, 16) != 16 ||
        memcmp(trailer + 8, magic, 8)) {
        fputs("Josi installer: embedded application is invalid\n", stderr); return 1;
    }
    uint64_t payload = 0;
    for (int index = 7; index >= 0; --index) payload = (payload << 8) | trailer[index];
    if (!payload || payload > (uint64_t)info.st_size - 16) {
        fputs("Josi installer: embedded application length is invalid\n", stderr); return 1;
    }
    if (lseek(source, info.st_size - 16 - (off_t)payload, SEEK_SET) < 0) {
        fputs("Josi installer: cannot read embedded application\n", stderr); return 1;
    }
    char directory[] = "/tmp/josi-ce-installer-XXXXXX";
    if (!mkdtemp(directory)) { perror("Josi installer"); return 1; }
    char target_path[sizeof directory + 32];
    snprintf(target_path, sizeof target_path, "%s/installer.AppImage", directory);
    int target = open(target_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0700);
    if (target < 0 || copy_bytes(source, target, payload) || fsync(target) || close(target)) {
        perror("Josi installer"); unlink(target_path); rmdir(directory); return 1;
    }
    close(source);
    if (setenv("APPIMAGE_EXTRACT_AND_RUN", "1", 1)) {
        perror("Josi installer"); unlink(target_path); rmdir(directory); return 1;
    }
    pid_t child = fork();
    if (child == 0) {
        argv[0] = target_path;
        execv(target_path, argv);
        perror("Josi installer"); _exit(127);
    }
    int status = 1;
    if (child > 0) while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    unlink(target_path);
    rmdir(directory);
    if (child < 0) return 1;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    return 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
}

/* Synthetic-test ACL setter only; never built into or shipped with the runner. */
#define _DARWIN_C_SOURCE 1
#include <sys/types.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <membership.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3) return 1;
  int fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat info;
  if (fd < 0 || fstat(fd, &info) || info.st_uid != getuid()) return 2;
  acl_t acl = acl_init(1);
  if (!acl) return 3;
  int result = 1;
  if (strcmp(argv[2], "empty")) {
    int inherit = !strcmp(argv[2], "deny_inherit"), allow = !strcmp(argv[2], "allow");
    if (!inherit && !allow && strcmp(argv[2], "deny")) goto done;
    acl_entry_t entry; acl_permset_t permissions; acl_flagset_t flags; uuid_t qualifier;
    if (acl_create_entry(&acl, &entry) || mbr_uid_to_uuid(getuid(), qualifier) ||
        acl_set_tag_type(entry, allow ? ACL_EXTENDED_ALLOW : ACL_EXTENDED_DENY) ||
        acl_set_qualifier(entry, qualifier) || acl_get_permset(entry, &permissions) ||
        acl_add_perm(permissions, inherit ? ACL_WRITE_EXTATTRIBUTES : allow ? ACL_ADD_SUBDIRECTORY : ACL_DELETE)) goto done;
    if (inherit && (acl_get_flagset_np(entry, &flags) || acl_add_flag_np(flags, ACL_ENTRY_FILE_INHERIT) ||
        acl_add_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT))) goto done;
  }
  result = acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED) != 0;
done:
  acl_free(acl); close(fd); return result;
}
